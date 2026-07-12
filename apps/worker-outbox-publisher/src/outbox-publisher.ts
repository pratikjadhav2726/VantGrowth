import type { OutboxRepository } from "@growthos/db";
import { tenantScopedSubject } from "@growthos/db";
import {
  type N8nDispatchRequest,
  type N8nDispatchResult,
  n8nDispatchRequestSchema,
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
}

const N8N_DISPATCH_EVENT_TYPE = "n8n.dispatch.requested.v1";

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
            if (event.eventType === N8N_DISPATCH_EVENT_TYPE) {
              await this.dispatchN8nAction(event.payload);
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
  ): Promise<void> {
    if (!this.deps.n8nDispatchClient) {
      throw new Error("n8n dispatch client is not configured");
    }

    const request = n8nDispatchRequestSchema.parse(payload);
    const result = await this.deps.n8nDispatchClient.dispatch(request);
    if (result.ok) return;

    if (!result.retryable) return;

    throw new Error(
      `Retryable n8n dispatch failure: ${result.status ?? "network"} ${result.error}`,
    );
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
