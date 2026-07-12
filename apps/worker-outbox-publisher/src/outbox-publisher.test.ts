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

  it("dispatches n8n requests through the n8n client instead of NATS", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const publish = vi.fn(async () => undefined);
    const dispatch = vi.fn(async () => ({
      ok: true as const,
      status: 202,
      body: { accepted: true },
    }));
    const publisher = new OutboxPublisher({
      outboxRepository,
      eventPublisher: { publish },
      n8nDispatchClient: { dispatch },
    });

    await outboxRepository.enqueue({
      tenantId: tenantA,
      eventType: "n8n.dispatch.requested.v1",
      idempotencyKey: "act-1",
      payload: {
        tenantId: tenantA,
        actionId: "act-1",
        actionType: "send_email",
        approvedBy: "founder",
        idempotencyKey: "act-1",
        payload: { to: "buyer@example.com" },
      },
    });

    const publishedCount = await publisher.publishPendingForTenant(tenantA, 50);
    const remaining = await outboxRepository.listUnconsumed(tenantA, 50);

    expect(publishedCount).toBe(1);
    expect(publish).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "act-1",
        idempotencyKey: "act-1",
      }),
    );
    expect(remaining).toHaveLength(0);
  });

  it("keeps retryable n8n dispatch failures unconsumed", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const publisher = new OutboxPublisher({
      outboxRepository,
      eventPublisher: { publish: vi.fn(async () => undefined) },
      n8nDispatchClient: {
        dispatch: vi.fn(async () => ({
          ok: false as const,
          status: 503,
          error: "n8n unavailable",
          retryable: true,
        })),
      },
    });

    await outboxRepository.enqueue({
      tenantId: tenantA,
      eventType: "n8n.dispatch.requested.v1",
      idempotencyKey: "act-2",
      payload: {
        tenantId: tenantA,
        actionId: "act-2",
        actionType: "send_email",
        approvedBy: "founder",
        idempotencyKey: "act-2",
        payload: {},
      },
    });

    await expect(
      publisher.publishPendingForTenant(tenantA, 50),
    ).rejects.toThrow("Retryable n8n dispatch failure");

    const remaining = await outboxRepository.listUnconsumed(tenantA, 50);
    expect(remaining).toHaveLength(1);
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
