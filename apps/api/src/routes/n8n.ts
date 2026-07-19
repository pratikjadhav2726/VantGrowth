import {
  ExternalActionConflictError,
  ExternalActionNotFoundError,
  ExternalActionStateError,
  type ExternalActionsRepository,
  type OutboxRepository,
  type SignalEventsRepository,
} from "@growthos/db";
import {
  type N8nDispatchClient,
  n8nCanonicalSignalEnvelopeSchema,
  n8nDispatchResultCallbackSchema,
  n8nTypedDispatchRequestSchema,
  verifyN8nSignature,
} from "@growthos/n8n";
import {
  SpanStatusCode,
  createLogger,
  getTracer,
} from "@growthos/observability";
import { Hono } from "hono";
import { z } from "zod";
import { ServiceUnavailableError, UnauthorizedError } from "../http-errors.js";

export interface N8nRouteDependencies {
  signalEventsRepository: SignalEventsRepository | null;
  outboxRepository: OutboxRepository | null;
  externalActionsRepository: ExternalActionsRepository | null;
  n8nSharedSecret: string | null;
  n8nDispatchClient?: N8nDispatchClient | null;
  n8nDispatchWebhookUrl?: string | null;
  n8nDispatchResultCallbackUrl?: string | null;
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
  Boolean(
    deps.externalActionsRepository &&
      deps.n8nSharedSecret &&
      deps.n8nDispatchResultCallbackUrl &&
      (deps.n8nDispatchClient || deps.n8nDispatchWebhookUrl),
  );

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
        if (!deps.n8nSharedSecret) {
          throw new ServiceUnavailableError(
            "N8N_SHARED_SECRET is required for n8n signal ingestion.",
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
        const signature = c.req.header("X-GrowthOS-Signature");
        if (!verifyN8nSignature(rawBody, signature, deps.n8nSharedSecret)) {
          log.warn(
            { tenant_id: tenantIdResult.data },
            "Rejected n8n signal with invalid signature",
          );
          return c.json({ error: "Invalid n8n signature" }, 401);
        }

        const parsedBody = parseJsonBody(rawBody);
        if (!parsedBody) {
          return c.json({ error: "Request body must be valid JSON" }, 400);
        }

        const envelopeResult =
          n8nCanonicalSignalEnvelopeSchema.safeParse(parsedBody);
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
        if (!deps.externalActionsRepository) {
          throw new ServiceUnavailableError(
            "External actions repository is not configured. Set DATABASE_URL.",
          );
        }
        if (!isDispatchConfigured(deps)) {
          throw new ServiceUnavailableError(
            "n8n dispatch is not fully configured. Set N8N_DISPATCH_WEBHOOK_URL, N8N_DISPATCH_RESULT_CALLBACK_URL, and N8N_SHARED_SECRET.",
          );
        }

        // The authenticated service caller declares its tenant in a header.
        // Keep the body tenant only as a consistency check so a caller cannot
        // enqueue an action into another tenant by changing JSON input.
        const tenantIdResult = tenantIdHeaderSchema.safeParse(
          c.req.header("X-Tenant-Id"),
        );
        if (!tenantIdResult.success) {
          return c.json({ error: "X-Tenant-Id header is required" }, 400);
        }

        const body = await c.req.json().catch(() => null);
        if (!body) {
          return c.json({ error: "Request body must be valid JSON" }, 400);
        }

        const requestResult = n8nTypedDispatchRequestSchema.safeParse(body);
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
        if (request.tenantId !== tenantIdResult.data) {
          log.warn(
            {
              header_tenant_id: tenantIdResult.data,
              body_tenant_id: request.tenantId,
              action_id: request.actionId,
            },
            "Rejected n8n dispatch with mismatched tenant identity",
          );
          return c.json(
            { error: "tenantId must match the X-Tenant-Id header" },
            403,
          );
        }
        span.setAttributes({
          tenant_id: tenantIdResult.data,
          action_id: request.actionId,
          action_type: request.actionType,
          idempotency_key: request.idempotencyKey,
        });

        const result = await deps.externalActionsRepository.enqueueRequested({
          tenantId: tenantIdResult.data,
          actionId: request.actionId,
          actionType: request.actionType,
          approvedBy: request.approvedBy,
          idempotencyKey: request.idempotencyKey,
          requestPayload: request.payload,
        });

        log.info(
          {
            tenant_id: tenantIdResult.data,
            action_id: request.actionId,
            action_type: request.actionType,
            external_action_id: result.action.id,
            outbox_event_id: result.event.id,
            duplicate: result.isDuplicate,
          },
          "Enqueued n8n dispatch request",
        );

        return c.json(
          {
            accepted: true,
            actionId: result.action.actionId,
            externalActionId: result.action.id,
            state: result.action.state,
            duplicate: result.isDuplicate,
            eventId: result.event.id,
            trackingId: `${tenantIdResult.data}:${request.idempotencyKey}`,
            eventType: result.event.eventType,
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

  route.post("/dispatch-results", async (c) => {
    return tracer.startActiveSpan("n8n.dispatch.result", async (span) => {
      try {
        if (!deps.externalActionsRepository) {
          throw new ServiceUnavailableError(
            "External actions repository is not configured. Set DATABASE_URL.",
          );
        }
        // A terminal callback changes durable action state, so this endpoint is
        // deliberately fail-closed rather than accepting unsigned local calls.
        if (!deps.n8nSharedSecret) {
          throw new ServiceUnavailableError(
            "N8N_SHARED_SECRET is required for n8n dispatch result callbacks.",
          );
        }

        const rawBody = await c.req.text();
        const signature = c.req.header("X-GrowthOS-Signature");
        if (!verifyN8nSignature(rawBody, signature, deps.n8nSharedSecret)) {
          log.warn("Rejected n8n dispatch result with invalid signature");
          throw new UnauthorizedError("Invalid n8n signature");
        }
        const parsedBody = parseJsonBody(rawBody);
        if (!parsedBody) {
          return c.json({ error: "Request body must be valid JSON" }, 400);
        }

        const callbackResult =
          n8nDispatchResultCallbackSchema.safeParse(parsedBody);
        if (!callbackResult.success) {
          return c.json(
            {
              error: "Invalid n8n dispatch result callback",
              details: callbackResult.error.flatten().fieldErrors,
            },
            422,
          );
        }

        const callback = callbackResult.data;
        span.setAttributes({
          tenant_id: callback.tenantId,
          action_id: callback.actionId,
          callback_id: callback.callbackId,
          outcome_status: callback.status,
          ...(callback.executionId
            ? { execution_id: callback.executionId }
            : {}),
        });
        try {
          const { occurredAt, ...callbackPayload } = callback;
          const result = await deps.externalActionsRepository.recordOutcome({
            ...callbackPayload,
            ...(occurredAt ? { occurredAt: new Date(occurredAt) } : {}),
          });
          log.info(
            {
              tenant_id: callback.tenantId,
              action_id: callback.actionId,
              callback_id: callback.callbackId,
              status: result.action.state,
              duplicate: result.isDuplicate,
            },
            "Recorded n8n dispatch result",
          );
          return c.json(
            {
              accepted: true,
              duplicate: result.isDuplicate,
              actionId: result.action.actionId,
              externalActionId: result.action.id,
              state: result.action.state,
            },
            202,
          );
        } catch (error) {
          if (error instanceof ExternalActionNotFoundError) {
            return c.json({ error: error.message }, 404);
          }
          if (
            error instanceof ExternalActionConflictError ||
            error instanceof ExternalActionStateError
          ) {
            return c.json({ error: error.message }, 409);
          }
          throw error;
        }
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
