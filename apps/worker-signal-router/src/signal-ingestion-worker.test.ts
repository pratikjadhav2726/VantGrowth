import {
  InMemoryOutboxRepository,
  InMemorySignalEventsRepository,
} from "@growthos/db";
import { describe, expect, it } from "vitest";
import { SignalRouter } from "./signal-router.js";
import {
  SignalIngestionWorker,
  resolveSignalKind,
  signalRouterRuntimeConfigFromEnv,
  stableRequestId,
} from "./signal-ingestion-worker.js";

const tenantId = "00000000-0000-4000-8000-000000000001";

describe("SignalIngestionWorker", () => {
  it("routes a durable signal into an idempotent intel request before marking it processed", async () => {
    const signalEventsRepository = new InMemorySignalEventsRepository();
    const outboxRepository = new InMemoryOutboxRepository();
    const signal = await signalEventsRepository.ingest({
      tenantId,
      signalType: "competitive",
      source: "competitor.watch",
      externalId: "pricing-1",
      payload: {
        kind: "competitor.pricing_change",
        competitor: "Acme",
      },
    });
    const signalRouter = new SignalRouter({ outboxRepository });
    const worker = new SignalIngestionWorker({
      signalEventsRepository,
      outboxRepository,
      signalRouter,
    });

    const result = await worker.processTenant(tenantId, 10);

    expect(result.failures).toHaveLength(0);
    expect(result.processedSignalIds).toEqual([signal.event.id.toString()]);
    expect(
      await signalEventsRepository.listUnprocessed(tenantId, "competitive", 10),
    ).toHaveLength(0);

    const events = await outboxRepository.listUnconsumed(tenantId, 10);
    expect(events.map((event) => event.eventType)).toEqual([
      "signal.routed.v1",
      "intel_brief.requested.v1",
    ]);
    expect(events[1]?.payload).toMatchObject({
      schema_version: "intel_brief_requested.v1",
      tenant_id: tenantId,
      trigger: {
        signal_id: signal.event.id.toString(),
        kind: "competitor.pricing_change",
      },
    });
  });

  it("keeps an unprocessable signal in the durable inbox for recovery", async () => {
    const signalEventsRepository = new InMemorySignalEventsRepository();
    const outboxRepository = new InMemoryOutboxRepository();
    await signalEventsRepository.ingest({
      tenantId,
      signalType: "market",
      source: "market.watch",
      payload: { kind: "market.update" },
    });
    const signalRouter = new SignalRouter({
      outboxRepository: {
        enqueue: async () => {
          throw new Error("outbox unavailable");
        },
        markConsumed: (...args) => outboxRepository.markConsumed(...args),
        listUnconsumed: (...args) => outboxRepository.listUnconsumed(...args),
        listByEventType: (...args) =>
          outboxRepository.listByEventType(...args),
      },
    });
    const worker = new SignalIngestionWorker({
      signalEventsRepository,
      outboxRepository,
      signalRouter,
    });

    const result = await worker.processTenant(tenantId, 10);

    expect(result.failures).toHaveLength(1);
    expect(
      await signalEventsRepository.listUnprocessed(tenantId, "market", 10),
    ).toHaveLength(1);

    // Failure explicitly releases the claim, so recovery does not wait for an
    // arbitrary lease timeout.
    const claimed = await signalEventsRepository.claimUnprocessed(
      tenantId,
      "market",
      10,
      { owner: "recovery-router", leaseMs: 60_000 },
    );
    expect(claimed).toHaveLength(1);
  });

  it("derives stable requests and a safe default kind", async () => {
    const signalEventsRepository = new InMemorySignalEventsRepository();
    const signal = await signalEventsRepository.ingest({
      tenantId,
      signalType: "community",
      source: "community.watch",
      payload: {},
    });

    expect(resolveSignalKind(signal.event)).toBe("signal.community");
    expect(stableRequestId("tenant:signal:1")).toBe(
      stableRequestId("tenant:signal:1"),
    );
    expect(stableRequestId("tenant:signal:1")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("carries a valid experiment id from a durable signal into the intel request", async () => {
    const signalEventsRepository = new InMemorySignalEventsRepository();
    const outboxRepository = new InMemoryOutboxRepository();
    const experimentId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await signalEventsRepository.ingest({
      tenantId,
      signalType: "competitive",
      source: "competitor.watch",
      externalId: "pricing-experiment-1",
      payload: {
        kind: "competitor.pricing_change",
        experiment_id: experimentId,
      },
    });
    const worker = new SignalIngestionWorker({
      signalEventsRepository,
      outboxRepository,
      signalRouter: new SignalRouter({ outboxRepository }),
    });

    await worker.processTenant(tenantId, 10);
    const requests = await outboxRepository.listByEventType(
      tenantId,
      "intel_brief.requested.v1",
      10,
    );
    expect(requests[0]?.payload.experiment_id).toBe(experimentId);
  });
});

describe("signalRouterRuntimeConfigFromEnv", () => {
  it("uses dedicated tenant configuration before the outbox fallback", () => {
    expect(
      signalRouterRuntimeConfigFromEnv({
        SIGNAL_ROUTER_TENANT_IDS: tenantId,
      }),
    ).toMatchObject({ tenantIds: [tenantId], pollIntervalMs: 1_000 });
  });
});
