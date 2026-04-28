import type { OutboxRepository } from "@growthos/db";
import { tenantScopedSubject } from "@growthos/db";
import { z } from "zod";

export interface EventPublisher {
  publish(subject: string, payload: Record<string, unknown>): Promise<void>;
}

export interface OutboxPublisherDependencies {
  outboxRepository: OutboxRepository;
  eventPublisher: EventPublisher;
}

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
    const pending = await this.deps.outboxRepository.listUnconsumed(
      tenantId,
      limit,
    );
    let publishedCount = 0;

    for (const event of pending) {
      await this.deps.eventPublisher.publish(
        tenantScopedSubject(event.tenantId, event.eventType),
        event.payload,
      );
      await this.deps.outboxRepository.markConsumed(event.tenantId, event.id);
      publishedCount += 1;
    }

    return publishedCount;
  }

  async publishCycle(
    tenantIds: string[],
    limitPerTenant: number,
  ): Promise<PublishCycleResult> {
    const publishedByTenant: Record<string, number> = {};
    let publishedCount = 0;

    for (const tenantId of tenantIds) {
      const tenantPublishedCount = await this.publishPendingForTenant(
        tenantId,
        limitPerTenant,
      );
      publishedByTenant[tenantId] = tenantPublishedCount;
      publishedCount += tenantPublishedCount;
    }

    return { publishedCount, publishedByTenant };
  }
}
