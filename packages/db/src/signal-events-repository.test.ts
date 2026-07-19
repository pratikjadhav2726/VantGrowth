import { describe, expect, it } from "vitest";
import { InMemorySignalEventsRepository } from "./signal-events-repository.js";

const TENANT_A = "00000000-0000-4000-8000-000000000020";
const TENANT_B = "00000000-0000-4000-8000-000000000021";

const baseSignal = {
  tenantId: TENANT_A,
  signalType: "competitive" as const,
  source: "product-hunt",
  payload: { title: "Competitor X launched feature Y" },
};

describe("InMemorySignalEventsRepository", () => {
  it("ingests a signal and returns isDuplicate=false", async () => {
    const repo = new InMemorySignalEventsRepository();
    const { event, isDuplicate } = await repo.ingest(baseSignal);
    expect(isDuplicate).toBe(false);
    expect(event.tenantId).toBe(TENANT_A);
    expect(event.signalType).toBe("competitive");
    expect(event.processedAt).toBeNull();
  });

  it("assigns auto-incrementing bigint IDs", async () => {
    const repo = new InMemorySignalEventsRepository();
    const { event: e1 } = await repo.ingest(baseSignal);
    const { event: e2 } = await repo.ingest(baseSignal);
    expect(e1.id).toBe(BigInt(1));
    expect(e2.id).toBe(BigInt(2));
  });

  it("deduplicates by (tenantId, source, externalId) when externalId is set", async () => {
    const repo = new InMemorySignalEventsRepository();
    const params = { ...baseSignal, externalId: "ph-post-123" };

    const { event: first, isDuplicate: dup1 } = await repo.ingest(params);
    const { event: second, isDuplicate: dup2 } = await repo.ingest(params);

    expect(dup1).toBe(false);
    expect(dup2).toBe(true);
    expect(second.id).toBe(first.id); // same record returned
  });

  it("does NOT deduplicate when externalId is absent", async () => {
    const repo = new InMemorySignalEventsRepository();
    const { isDuplicate: d1 } = await repo.ingest(baseSignal);
    const { isDuplicate: d2 } = await repo.ingest(baseSignal);
    const { isDuplicate: d3 } = await repo.ingest(baseSignal);
    expect(d1).toBe(false);
    expect(d2).toBe(false);
    expect(d3).toBe(false);
  });

  it("externalId dedup is scoped to tenant", async () => {
    const repo = new InMemorySignalEventsRepository();
    const params = { ...baseSignal, externalId: "shared-id" };
    const paramsB = { ...params, tenantId: TENANT_B };

    await repo.ingest(params);
    const { isDuplicate } = await repo.ingest(paramsB); // different tenant
    expect(isDuplicate).toBe(false);
  });

  it("listUnprocessed returns signals in FIFO order", async () => {
    const repo = new InMemorySignalEventsRepository();
    const { event: e1 } = await repo.ingest(baseSignal);
    const { event: e2 } = await repo.ingest(baseSignal);
    const { event: e3 } = await repo.ingest(baseSignal);

    const unprocessed = await repo.listUnprocessed(TENANT_A, "competitive", 10);
    expect(unprocessed.map((e) => e.id)).toEqual([e1.id, e2.id, e3.id]);
  });

  it("listUnprocessed respects limit", async () => {
    const repo = new InMemorySignalEventsRepository();
    for (let i = 0; i < 5; i++) await repo.ingest(baseSignal);
    const unprocessed = await repo.listUnprocessed(TENANT_A, "competitive", 3);
    expect(unprocessed).toHaveLength(3);
  });

  it("listUnprocessed filters by signalType", async () => {
    const repo = new InMemorySignalEventsRepository();
    await repo.ingest(baseSignal); // competitive
    await repo.ingest({ ...baseSignal, signalType: "community" });

    const competitive = await repo.listUnprocessed(TENANT_A, "competitive", 10);
    const community = await repo.listUnprocessed(TENANT_A, "community", 10);
    expect(competitive).toHaveLength(1);
    expect(community).toHaveLength(1);
  });

  it("listUnprocessed is scoped to tenant", async () => {
    const repo = new InMemorySignalEventsRepository();
    await repo.ingest(baseSignal); // TENANT_A
    await repo.ingest({ ...baseSignal, tenantId: TENANT_B });

    const result = await repo.listUnprocessed(TENANT_A, "competitive", 10);
    expect(result).toHaveLength(1);
    expect(result[0]?.tenantId).toBe(TENANT_A);
  });

  it("leases a signal to one router replica and keeps it unavailable to another", async () => {
    const repo = new InMemorySignalEventsRepository();
    const { event } = await repo.ingest(baseSignal);

    const first = await repo.claimUnprocessed(TENANT_A, "competitive", 10, {
      owner: "router-a",
      leaseMs: 60_000,
    });
    const second = await repo.claimUnprocessed(TENANT_A, "competitive", 10, {
      owner: "router-b",
      leaseMs: 60_000,
    });

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      id: event.id,
      processingLeaseOwner: "router-a",
      processingAttempts: 1,
    });
    expect(second).toHaveLength(0);
  });

  it("releases a failed claim for retry without allowing another owner to release it", async () => {
    const repo = new InMemorySignalEventsRepository();
    const { event } = await repo.ingest(baseSignal);
    await repo.claimUnprocessed(TENANT_A, "competitive", 10, {
      owner: "router-a",
      leaseMs: 60_000,
    });

    await repo.releaseClaims(TENANT_A, [event.id], "router-b");
    expect(
      await repo.claimUnprocessed(TENANT_A, "competitive", 10, {
        owner: "router-b",
        leaseMs: 60_000,
      }),
    ).toHaveLength(0);

    await repo.releaseClaims(TENANT_A, [event.id], "router-a");
    const retry = await repo.claimUnprocessed(TENANT_A, "competitive", 10, {
      owner: "router-b",
      leaseMs: 60_000,
    });
    expect(retry[0]).toMatchObject({
      id: event.id,
      processingLeaseOwner: "router-b",
      processingAttempts: 2,
    });
  });

  it("markProcessed sets processedAt and hides record from listUnprocessed", async () => {
    const repo = new InMemorySignalEventsRepository();
    const { event: e1 } = await repo.ingest(baseSignal);
    const { event: e2 } = await repo.ingest(baseSignal);

    await repo.markProcessed(TENANT_A, [e1.id]);

    const unprocessed = await repo.listUnprocessed(TENANT_A, "competitive", 10);
    expect(unprocessed.map((e) => e.id)).toEqual([e2.id]);
  });

  it("markProcessed is idempotent", async () => {
    const repo = new InMemorySignalEventsRepository();
    const { event } = await repo.ingest(baseSignal);
    await repo.markProcessed(TENANT_A, [event.id]);
    await repo.markProcessed(TENANT_A, [event.id]); // second call — no throw
    expect(true).toBe(true);
  });

  it("markProcessed is a no-op for empty ids array", async () => {
    const repo = new InMemorySignalEventsRepository();
    await repo.ingest(baseSignal);
    await repo.markProcessed(TENANT_A, []); // no throw
    const unprocessed = await repo.listUnprocessed(TENANT_A, "competitive", 10);
    expect(unprocessed).toHaveLength(1);
  });

  it("markProcessed respects tenant scope", async () => {
    const repo = new InMemorySignalEventsRepository();
    const { event } = await repo.ingest(baseSignal);
    await repo.markProcessed(TENANT_B, [event.id]); // wrong tenant — no-op
    const unprocessed = await repo.listUnprocessed(TENANT_A, "competitive", 10);
    expect(unprocessed).toHaveLength(1); // still unprocessed
  });

  it("clears a processing lease when a claim is completed", async () => {
    const repo = new InMemorySignalEventsRepository();
    const { event } = await repo.ingest(baseSignal);
    await repo.claimUnprocessed(TENANT_A, "competitive", 10, {
      owner: "router-a",
      leaseMs: 60_000,
    });
    await repo.markProcessed(TENANT_A, [event.id]);

    const replay = await repo.claimUnprocessed(TENANT_A, "competitive", 10, {
      owner: "router-b",
      leaseMs: 60_000,
    });
    expect(replay).toHaveLength(0);
  });
});
