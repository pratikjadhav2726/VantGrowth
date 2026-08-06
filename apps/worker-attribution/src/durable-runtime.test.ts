import { InMemoryOutboxRepository } from "@growthos/db";
import { describe, expect, it, vi } from "vitest";
import { AttributionWorker } from "./attribution-worker.js";

const startDurableJetStreamConsumerMock = vi.hoisted(() => vi.fn());

vi.mock("@growthos/core", () => ({
  startDurableJetStreamConsumer: startDurableJetStreamConsumerMock,
}));

import { startAttributionSignalConsumer } from "./index.js";

const tenantId = "00000000-0000-4000-8000-000000000001";

interface ConsumerContext {
  subject: string;
  streamSequence: number;
  redeliveryCount: number;
}

type ConsumerHandler = (
  payload: Record<string, unknown>,
  context: ConsumerContext,
) => Promise<void>;

interface ConsumerHooks {
  onExhausted?: (
    payload: Record<string, unknown> | null,
    context: ConsumerContext,
    error: Error,
  ) => Promise<void>;
}

const registeredConsumer = (): {
  config: Record<string, unknown>;
  handler: ConsumerHandler;
  hooks: ConsumerHooks;
} => {
  const call = startDurableJetStreamConsumerMock.mock.calls[0];
  if (!call) throw new Error("Expected a durable consumer to be registered.");

  return {
    config: call[0] as Record<string, unknown>,
    handler: call[1] as ConsumerHandler,
    hooks: call[2] as ConsumerHooks,
  };
};

describe("attribution durable runtime", () => {
  it("uses the tenant-scoped signal stream and persists retry exhaustion", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const worker = new AttributionWorker({ outboxRepository });

    await startAttributionSignalConsumer(worker, outboxRepository);

    const { config, handler, hooks } = registeredConsumer();
    expect(config).toMatchObject({
      subject: "t.*.attribution.signal.v1",
      durableName: "growthos_attribution",
      queueGroup: "growthos-worker-attribution",
      maxDeliver: 5,
    });

    const context = {
      subject: `t.${tenantId}.attribution.signal.v1`,
      streamSequence: 42,
      redeliveryCount: 5,
    };
    await handler(
      {
        tenant_id: tenantId,
        attribution_id: "attr-runtime-1",
        dedupe_key: "attr-runtime-1",
        source: "nightly_rollup",
        opportunity_id: "opp-runtime-1",
        account_id: "acct-runtime-1",
        window: "30d",
        touchpoints: [],
        conversion_value_micros: 250_000,
      },
      context,
    );

    if (!hooks.onExhausted) {
      throw new Error("Expected an exhausted-message handler.");
    }
    await hooks.onExhausted(
      { attribution_id: "bad-attribution" },
      context,
      new Error("invalid attribution signal"),
    );

    const events = await outboxRepository.listUnconsumed(tenantId, 10);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.eventType)).toEqual([
      "attribution.rollup.computed.v1",
      "worker.dead_lettered.v1",
    ]);
    expect(events[1]?.payload).toMatchObject({
      worker: "attribution",
      stream_sequence: 42,
      redelivery_count: 5,
    });
  });
});
