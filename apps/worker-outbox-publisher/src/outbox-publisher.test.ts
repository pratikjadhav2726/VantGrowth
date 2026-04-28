import { InMemoryOutboxRepository } from "@growthos/db";
import { describe, expect, it, vi } from "vitest";
import { OutboxPublisher, runtimeConfigFromEnv } from "./outbox-publisher.js";

const tenantA = "11111111-1111-4111-8111-111111111111";
const tenantB = "22222222-2222-4222-8222-222222222222";

describe("OutboxPublisher", () => {
  it("publishes unconsumed events and marks them consumed", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const publish = vi.fn(async () => undefined);
    const publisher = new OutboxPublisher({
      outboxRepository,
      eventPublisher: { publish },
    });

    await outboxRepository.enqueue({
      tenantId: tenantA,
      eventType: "signal.routed.v1",
      idempotencyKey: "dedupe-1",
      payload: { signal_id: "sig-1" },
    });

    const publishedCount = await publisher.publishPendingForTenant(tenantA, 50);
    const remaining = await outboxRepository.listUnconsumed(tenantA, 50);

    expect(publishedCount).toBe(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      "t.11111111-1111-4111-8111-111111111111.signal.routed.v1",
      { signal_id: "sig-1" },
    );
    expect(remaining).toHaveLength(0);
  });

  it("does not mark consumed when publish fails", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const publisher = new OutboxPublisher({
      outboxRepository,
      eventPublisher: {
        publish: vi.fn(async () => {
          throw new Error("jetstream unavailable");
        }),
      },
    });

    await outboxRepository.enqueue({
      tenantId: tenantA,
      eventType: "critique.completed.v1",
      idempotencyKey: "dedupe-2",
      payload: { critique_id: "crt-1" },
    });

    await expect(
      publisher.publishPendingForTenant(tenantA, 50),
    ).rejects.toThrow("jetstream unavailable");

    const remaining = await outboxRepository.listUnconsumed(tenantA, 50);
    expect(remaining).toHaveLength(1);
  });

  it("publishes in tenant batches and returns cycle metrics", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const publish = vi.fn(async () => undefined);
    const publisher = new OutboxPublisher({
      outboxRepository,
      eventPublisher: { publish },
    });

    await outboxRepository.enqueue({
      tenantId: tenantA,
      eventType: "signal.routed.v1",
      idempotencyKey: "dedupe-a",
      payload: { signal_id: "a" },
    });
    await outboxRepository.enqueue({
      tenantId: tenantB,
      eventType: "critique.completed.v1",
      idempotencyKey: "dedupe-b",
      payload: { critique_id: "b" },
    });

    const result = await publisher.publishCycle([tenantA, tenantB], 10);

    expect(result.publishedCount).toBe(2);
    expect(result.publishedByTenant).toEqual({
      [tenantA]: 1,
      [tenantB]: 1,
    });
    expect(publish).toHaveBeenCalledTimes(2);
  });
});

describe("runtimeConfigFromEnv", () => {
  it("parses tenant and runtime values from env", () => {
    const config = runtimeConfigFromEnv({
      OUTBOX_TENANT_IDS: `${tenantA},${tenantB}`,
      OUTBOX_BATCH_SIZE_PER_TENANT: "25",
      OUTBOX_POLL_INTERVAL_MS: "1500",
    });

    expect(config).toEqual({
      tenantIds: [tenantA, tenantB],
      batchSizePerTenant: 25,
      pollIntervalMs: 1500,
    });
  });
});
