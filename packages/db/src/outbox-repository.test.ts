import { describe, expect, it } from "vitest";
import { InMemoryOutboxRepository } from "./outbox-repository.js";

const tenantId = "00000000-0000-4000-8000-000000000001";

describe("InMemoryOutboxRepository", () => {
  it("deduplicates events by tenant, event type, and idempotency key", async () => {
    const repository = new InMemoryOutboxRepository();

    const first = await repository.enqueue({
      tenantId,
      eventType: "tenant.created.v1",
      idempotencyKey: "idem-1",
      payload: { plan: "starter" }
    });

    const second = await repository.enqueue({
      tenantId,
      eventType: "tenant.created.v1",
      idempotencyKey: "idem-1",
      payload: { plan: "starter" }
    });

    expect(second.id).toBe(first.id);
  });

  it("lists only unconsumed events for the requested tenant", async () => {
    const repository = new InMemoryOutboxRepository();
    const event = await repository.enqueue({
      tenantId,
      eventType: "approval.decided.v1",
      idempotencyKey: "approval-1",
      payload: { decision: "approved" }
    });

    await repository.enqueue({
      tenantId: "00000000-0000-4000-8000-000000000002",
      eventType: "approval.decided.v1",
      idempotencyKey: "approval-1",
      payload: { decision: "approved" }
    });

    const before = await repository.listUnconsumed(tenantId, 10);
    expect(before).toHaveLength(1);

    await repository.markConsumed(tenantId, event.id);
    const after = await repository.listUnconsumed(tenantId, 10);
    expect(after).toHaveLength(0);
  });
});
