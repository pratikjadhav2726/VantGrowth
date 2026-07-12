import type { OutboxRepository, SignalEventsRepository } from "@growthos/db";
import {
  type N8nDispatchClient,
  n8nDispatchRequestSchema,
  n8nSignalEnvelopeSchema,
  verifyN8nSignature,
} from "@growthos/n8n";
import {
  SpanStatusCode,
  createLogger,
  getTracer,
} from "@growthos/observability";
import { Hono } from "hono";
import { z } from "zod";
import { ServiceUnavailableError } from "../http-errors.js";

export interface N8nRouteDependencies {
  signalEventsRepository: SignalEventsRepository | null;
  outboxRepository: OutboxRepository | null;
  n8nSharedSecret: string | null;
  n8nDispatchClient?: N8nDispatchClient | null;
  n8nDispatchWebhookUrl?: string | null;
}

const tenantIdHeaderSchema = z.string().uuid();
const idempotencyKeyHeaderSchema = z.string().min(1).max(255);

const parseJsonBody = (rawBody: string): unknown => {
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return null;
  }
};

const isDispatchConfigured = (deps: N8nRouteDependencies): boolean =>
  Boolean(deps.n8nDispatchClient || deps.n8nDispatchWebhookUrl);

const log = createLogger("growthos.api.n8n");
const tracer = getTracer("growthos.api.n8n");

export const createN8nRoutes = (deps: N8nRouteDependencies): Hono => {
  const route = new Hono();

  route.post("/signals", async (c) => {
    return tracer.startActiveSpan("n8n.signals.ingest", async (span) => {
      try {
        if (!deps.signalEventsRepository) {
          throw new ServiceUnavailableError(
            "Signal events repository is not configured. Set DATABASE_URL.",
          );
        }

        const tenantIdResult = tenantIdHeaderSchema.safeParse(
          c.req.header("X-Tenant-Id"),
        );
        if (!tenantIdResult.success) {
          return c.json({ error: "X-Tenant-Id header is required" }, 400);
        }
        span.setAttribute("tenant_id", tenantIdResult.data);

        const idempotencyKeyResult = idempotencyKeyHeaderSchema.safeParse(
          c.req.header("Idempotency-Key"),
        );
        if (!idempotencyKeyResult.success) {
          return c.json({ error: "Idempotency-Key header is required" }, 400);
        }

        const rawBody = await c.req.text();
        if (deps.n8nSharedSecret) {
          const signature = c.req.header("X-GrowthOS-Signature");
          if (!verifyN8nSignature(rawBody, signature, deps.n8nSharedSecret)) {
            log.warn(
              { tenant_id: tenantIdResult.data },
              "Rejected n8n signal with invalid signature",
            );
            return c.json({ error: "Invalid n8n signature" }, 401);
          }
        }

        const parsedBody = parseJsonBody(rawBody);
        if (!parsedBody) {
          return c.json({ error: "Request body must be valid JSON" }, 400);
        }

        const envelopeResult = n8nSignalEnvelopeSchema.safeParse(parsedBody);
        if (!envelopeResult.success) {
          return c.json(
            {
              error: "Invalid n8n signal envelope",
              details: envelopeResult.error.flatten().fieldErrors,
            },
            422,
          );
        }

        const envelope = envelopeResult.data;
        span.setAttributes({
          event_id: envelope.eventId,
          signal_type: envelope.signalType,
          n8n_source: envelope.source,
          ...(envelope.workflowId ? { workflow_id: envelope.workflowId } : {}),
          ...(envelope.executionId
            ? { execution_id: envelope.executionId }
            : {}),
        });

        const result = await deps.signalEventsRepository.ingest({
          tenantId: tenantIdResult.data,
          signalType: envelope.signalType,
          source: `n8n:${envelope.source}`,
          externalId: envelope.eventId,
          payload: {
            ...envelope.payload,
            n8n: {
              eventId: envelope.eventId,
              source: envelope.source,
              occurredAt: envelope.occurredAt,
              idempotencyKey: idempotencyKeyResult.data,
              ...(envelope.workflowId
                ? { workflowId: envelope.workflowId }
                : {}),
              ...(envelope.executionId
                ? { executionId: envelope.executionId }
                : {}),
            },
          },
        });

        log.info(
          {
            tenant_id: tenantIdResult.data,
            event_id: envelope.eventId,
            workflow_id: envelope.workflowId,
            execution_id: envelope.executionId,
            inserted: !result.isDuplicate,
          },
          "Accepted n8n signal",
        );

        return c.json(
          {
            accepted: true,
            inserted: !result.isDuplicate,
            signalId: result.event.id.toString(),
          },
          202,
        );
      } catch (error) {
        span.recordException(
          error instanceof Error ? error : new Error(String(error)),
        );
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  });

  route.post("/dispatch", async (c) => {
    return tracer.startActiveSpan("n8n.dispatch.enqueue", async (span) => {
      try {
        if (!deps.outboxRepository) {
          throw new ServiceUnavailableError(
            "Outbox repository is not configured. Set DATABASE_URL.",
          );
        }
        if (!isDispatchConfigured(deps)) {
          throw new ServiceUnavailableError(
            "n8n dispatch is not configured. Set N8N_DISPATCH_WEBHOOK_URL.",
          );
        }

        const body = await c.req.json().catch(() => null);
        if (!body) {
          return c.json({ error: "Request body must be valid JSON" }, 400);
        }

        const requestResult = n8nDispatchRequestSchema.safeParse(body);
        if (!requestResult.success) {
          return c.json(
            {
              error: "Invalid n8n dispatch request",
              details: requestResult.error.flatten().fieldErrors,
            },
            422,
          );
        }

        const request = requestResult.data;
        span.setAttributes({
          tenant_id: request.tenantId,
          action_id: request.actionId,
          action_type: request.actionType,
          idempotency_key: request.idempotencyKey,
        });

        const event = await deps.outboxRepository.enqueue({
          tenantId: request.tenantId,
          eventType: "n8n.dispatch.requested.v1",
          idempotencyKey: request.idempotencyKey,
          payload: request,
        });

        log.info(
          {
            tenant_id: request.tenantId,
            action_id: request.actionId,
            action_type: request.actionType,
            outbox_event_id: event.id,
          },
          "Enqueued n8n dispatch request",
        );

        return c.json(
          {
            accepted: true,
            eventId: event.id,
            trackingId: `${request.tenantId}:${request.idempotencyKey}`,
            eventType: event.eventType,
          },
          202,
        );
      } catch (error) {
        span.recordException(
          error instanceof Error ? error : new Error(String(error)),
        );
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  });

  return route;
};
