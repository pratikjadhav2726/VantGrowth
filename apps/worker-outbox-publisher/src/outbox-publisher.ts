import { createHash } from "node:crypto";
import type {
  ComponentHealthRepository,
  ExternalActionsRepository,
  IncidentRepository,
  OutboxRepository,
  StoredOutboxEvent,
} from "@growthos/db";
import { tenantScopedSubject } from "@growthos/db";
import {
  type N8nDispatchRequest,
  type N8nDispatchResult,
  extractN8nDispatchReceiptMetadata,
  n8nTypedDispatchRequestSchema,
} from "@growthos/n8n";
import {
  SpanKind,
  SpanStatusCode,
  getMeter,
  getTracer,
} from "@growthos/observability";
import { z } from "zod";

const tracer = getTracer("growthos.worker-outbox-publisher");
const meter = getMeter("growthos.worker-outbox-publisher");
const eventsPublished = meter.createCounter("outbox.events.published.total", {
  description: "Total outbox events successfully published to NATS",
  unit: "{event}",
});
const cycleDurationMs = meter.createHistogram("outbox.cycle.duration_ms", {
  description: "Duration of a full outbox drain cycle across all tenants",
  unit: "ms",
});

export interface EventPublisher {
  publish(subject: string, payload: Record<string, unknown>): Promise<void>;
}

export interface N8nDispatchPort {
  dispatch(input: N8nDispatchRequest): Promise<N8nDispatchResult>;
}

export interface OutboxPublisherDependencies {
  outboxRepository: OutboxRepository;
  eventPublisher: EventPublisher;
  n8nDispatchClient?: N8nDispatchPort | null;
  externalActionsRepository?: ExternalActionsRepository | null;
  /** Persists operational incidents before their outbox rows are acknowledged. */
  incidentRepository?: IncidentRepository | null;
  /** Persists the current worker safety posture before acknowledgement. */
  componentHealthRepository?: ComponentHealthRepository | null;
  n8nRetryBackoffMs?: number;
  n8nDispatchLeaseMs?: number;
  n8nDispatchWorkerId?: string;
  n8nDispatchResultCallbackUrl?: string | null;
  /** Live environments require a terminal callback before allowing dispatch. */
  n8nRequireResultCallback?: boolean;
}

const N8N_DISPATCH_EVENT_TYPE = "n8n.dispatch.requested.v1";
const INCIDENT_OPENED_EVENT_TYPE = "incident.opened.v1";
const WORKER_DEAD_LETTER_EVENT_TYPE = "worker.dead_lettered.v1";

const incidentSeveritySchema = z.enum(["low", "medium", "high", "critical"]);
const healingActionSchema = z.enum([
  "none",
  "resume",
  "retry_with_backoff",
  "use_fallback",
  "rollback",
  "quarantine_and_escalate",
]);
const incidentOpenedPayloadSchema = z.object({
  incident_key: z.string().trim().min(1).max(255),
  component_id: z.string().trim().min(1).max(255),
  severity: incidentSeveritySchema,
  title: z.string().trim().min(1).max(500),
  summary: z.string().trim().min(1).max(2_000),
  action: healingActionSchema.optional(),
  rollback_version_ref: z.string().trim().min(1).max(500).optional(),
  diagnostic_metadata: z.record(z.unknown()).default({}),
});
const workerDeadLetterPayloadSchema = z.object({
  worker: z.string().trim().min(1).max(255),
  source_subject: z.string().trim().min(1).max(1_000),
  stream_sequence: z.union([z.string().min(1), z.number().int().nonnegative()]),
  redelivery_count: z.number().int().nonnegative().optional(),
  error: z.string().trim().min(1).max(10_000),
  failed_payload: z.record(z.unknown()).optional(),
});

const runtimeConfigSchema = z.object({
  tenantIds: z.array(z.string().uuid()).min(1),
  batchSizePerTenant: z.number().int().positive().default(100),
  pollIntervalMs: z.number().int().positive().default(1000),
});

export type OutboxPublisherRuntimeConfig = z.infer<typeof runtimeConfigSchema>;

export interface PublishCycleResult {
  publishedCount: number;
  publishedByTenant: Record<string, number>;
}

export const runtimeConfigFromEnv = (
  env: Record<string, string | undefined> = process.env,
): OutboxPublisherRuntimeConfig => {
  const tenantIds = (env.OUTBOX_TENANT_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return runtimeConfigSchema.parse({
    tenantIds,
    batchSizePerTenant: Number(env.OUTBOX_BATCH_SIZE_PER_TENANT ?? "100"),
    pollIntervalMs: Number(env.OUTBOX_POLL_INTERVAL_MS ?? "1000"),
  });
};

export class OutboxPublisher {
  constructor(private readonly deps: OutboxPublisherDependencies) {}

  private get retryBackoffMs(): number {
    const value = this.deps.n8nRetryBackoffMs ?? 60_000;
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(
        "n8n retry backoff must be a positive number of milliseconds",
      );
    }
    return value;
  }

  private get dispatchLeaseMs(): number {
    const value = this.deps.n8nDispatchLeaseMs ?? 120_000;
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(
        "n8n dispatch lease must be a positive number of milliseconds",
      );
    }
    return value;
  }

  private get dispatchWorkerId(): string {
    return (
      this.deps.n8nDispatchWorkerId ??
      `outbox-publisher:${process.env.HOSTNAME ?? "local"}:${process.pid}`
    );
  }

  private static sanitizeError(value: string): string {
    return value
      .replace(/(bearer\s+)[^\s,;]+/gi, "$1[redacted]")
      .replace(/(api[_-]?key|token|secret)=[^\s,;]+/gi, "$1=[redacted]")
      .slice(0, 1_000);
  }

  private static payloadDigest(
    payload: Record<string, unknown> | undefined,
  ): string | null {
    if (!payload) return null;
    try {
      return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    } catch {
      return null;
    }
  }

  /**
   * The outbox is the last durable boundary before an event leaves GrowthOS.
   * Materialize founder-visible incidents first, so a successful publish can
   * never make a dead letter or incident visible only in NATS/logging.
   */
  private async persistOperationalState(
    event: StoredOutboxEvent,
  ): Promise<void> {
    if (event.eventType === INCIDENT_OPENED_EVENT_TYPE) {
      if (!this.deps.incidentRepository) return;
      const payload = incidentOpenedPayloadSchema.parse(event.payload);
      await this.deps.incidentRepository.create(event.tenantId, {
        incidentKey: payload.incident_key,
        componentId: payload.component_id,
        severity: payload.severity,
        title: payload.title,
        summary: payload.summary,
        ...(payload.action ? { action: payload.action } : {}),
        ...(payload.rollback_version_ref
          ? { rollbackVersionRef: payload.rollback_version_ref }
          : {}),
        diagnosticMetadata: payload.diagnostic_metadata,
      });
      return;
    }

    if (event.eventType !== WORKER_DEAD_LETTER_EVENT_TYPE) return;
    const payload = workerDeadLetterPayloadSchema.parse(event.payload);
    const failedPayloadDigest = OutboxPublisher.payloadDigest(
      payload.failed_payload,
    );
    const incidentKey = `dead-letter:${payload.worker}:${payload.source_subject}:${payload.stream_sequence}`;
    const sanitizedError = OutboxPublisher.sanitizeError(payload.error);

    if (this.deps.incidentRepository) {
      await this.deps.incidentRepository.create(event.tenantId, {
        incidentKey,
        componentId: payload.worker,
        severity: "high",
        title: `Worker dead-lettered ${payload.worker} event`,
        summary: `The ${payload.worker} worker exhausted delivery attempts for ${payload.source_subject}: ${sanitizedError}`,
        action: "quarantine_and_escalate",
        diagnosticMetadata: {
          source_subject: payload.source_subject,
          stream_sequence: payload.stream_sequence,
          ...(payload.redelivery_count !== undefined
            ? { redelivery_count: payload.redelivery_count }
            : {}),
          ...(failedPayloadDigest
            ? { failed_payload_sha256: failedPayloadDigest }
            : {}),
        },
      });
    }

    if (this.deps.componentHealthRepository) {
      await this.deps.componentHealthRepository.record(event.tenantId, {
        componentId: payload.worker,
        idempotencyKey: incidentKey,
        state: "quarantined",
        errorRate: 1,
        consecutiveFailures: Math.max(1, payload.redelivery_count ?? 1),
        p95LatencyMs: 0,
        stalenessSeconds: 0,
        dependencyAvailable: false,
        fallbackAvailable: false,
        lastKnownGoodAvailable: false,
        recoveryAttempts: 0,
        guardrailBreached: true,
        action: "quarantine_and_escalate",
        allowExternalActions: false,
        reasons: [
          `Dead-lettered ${payload.source_subject} at stream sequence ${payload.stream_sequence}.`,
          sanitizedError,
        ],
      });
    }
  }

  async publishPendingForTenant(
    tenantId: string,
    limit: number,
  ): Promise<number> {
    return tracer.startActiveSpan(
      "outbox.drain_tenant",
      {
        kind: SpanKind.INTERNAL,
        attributes: { "tenant.id": tenantId, "outbox.limit": limit },
      },
      async (span) => {
        try {
          const pending = await this.deps.outboxRepository.listUnconsumed(
            tenantId,
            limit,
          );
          let publishedCount = 0;

          for (const event of pending) {
            await this.persistOperationalState(event);
            if (event.eventType === N8N_DISPATCH_EVENT_TYPE) {
              const result = await this.dispatchN8nAction(event.payload);
              if (result === "deferred") {
                continue;
              }
            } else {
              await this.deps.eventPublisher.publish(
                tenantScopedSubject(event.tenantId, event.eventType),
                event.payload,
              );
            }
            await this.deps.outboxRepository.markConsumed(
              event.tenantId,
              event.id,
            );
            publishedCount += 1;
          }

          span.setAttribute("outbox.published_count", publishedCount);
          eventsPublished.add(publishedCount, { "tenant.id": tenantId });
          return publishedCount;
        } catch (err: unknown) {
          span.recordException(
            err instanceof Error ? err : new Error(String(err)),
          );
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw err;
        } finally {
          span.end();
        }
      },
    );
  }

  private async dispatchN8nAction(
    payload: Record<string, unknown>,
  ): Promise<"consumed" | "deferred"> {
    if (!this.deps.n8nDispatchClient) {
      throw new Error("n8n dispatch client is not configured");
    }
    if (!this.deps.externalActionsRepository) {
      throw new Error(
        "external actions repository is not configured; refusing n8n dispatch without a durable lifecycle",
      );
    }
    if (
      this.deps.n8nRequireResultCallback &&
      !this.deps.n8nDispatchResultCallbackUrl
    ) {
      throw new Error(
        "n8n dispatch result callback URL is required in this environment",
      );
    }

    const request = n8nTypedDispatchRequestSchema.parse(payload);
    const claim = await this.deps.externalActionsRepository.claimDispatch({
      tenantId: request.tenantId,
      actionId: request.actionId,
      idempotencyKey: request.idempotencyKey,
      leaseOwner: this.dispatchWorkerId,
      leaseDurationMs: this.dispatchLeaseMs,
    });
    if (claim.disposition === "deferred" || claim.disposition === "in_flight") {
      return "deferred";
    }
    if (claim.disposition === "settled") return "consumed";

    const callback = this.deps.n8nDispatchResultCallbackUrl
      ? { url: this.deps.n8nDispatchResultCallbackUrl }
      : undefined;
    const result = await this.deps.n8nDispatchClient.dispatch({
      ...request,
      ...(callback ? { callback } : {}),
    });
    if (result.ok) {
      const metadata = extractN8nDispatchReceiptMetadata(result.body);
      await this.deps.externalActionsRepository.recordDispatchAccepted({
        tenantId: request.tenantId,
        actionId: request.actionId,
        idempotencyKey: request.idempotencyKey,
        leaseOwner: this.dispatchWorkerId,
        receipt: {
          httpStatus: result.status,
          body: result.body,
          ...metadata,
        },
      });
      return "consumed";
    }

    const errorCode = result.status
      ? `HTTP_${result.status}`
      : "N8N_NETWORK_ERROR";
    if (result.retryable) {
      await this.deps.externalActionsRepository.scheduleDispatchRetry({
        tenantId: request.tenantId,
        actionId: request.actionId,
        idempotencyKey: request.idempotencyKey,
        leaseOwner: this.dispatchWorkerId,
        retryAfterMs: this.retryBackoffMs,
        errorCode,
        errorMessage: result.error,
      });
      return "deferred";
    }

    await this.deps.externalActionsRepository.failDispatch({
      tenantId: request.tenantId,
      actionId: request.actionId,
      idempotencyKey: request.idempotencyKey,
      leaseOwner: this.dispatchWorkerId,
      errorCode,
      errorMessage: result.error,
    });
    return "consumed";
  }

  async publishCycle(
    tenantIds: string[],
    limitPerTenant: number,
  ): Promise<PublishCycleResult> {
    const startMs = Date.now();
    return tracer.startActiveSpan(
      "outbox.publish_cycle",
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          "tenant.count": tenantIds.length,
          "outbox.limit_per_tenant": limitPerTenant,
        },
      },
      async (span) => {
        const publishedByTenant: Record<string, number> = {};
        let publishedCount = 0;

        try {
          for (const tenantId of tenantIds) {
            const tenantPublishedCount = await this.publishPendingForTenant(
              tenantId,
              limitPerTenant,
            );
            publishedByTenant[tenantId] = tenantPublishedCount;
            publishedCount += tenantPublishedCount;
          }

          span.setAttribute("outbox.total_published", publishedCount);
          return { publishedCount, publishedByTenant };
        } catch (err: unknown) {
          span.recordException(
            err instanceof Error ? err : new Error(String(err)),
          );
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw err;
        } finally {
          span.end();
          cycleDurationMs.record(Date.now() - startMs, {
            "tenant.count": tenantIds.length,
          });
        }
      },
    );
  }
}
