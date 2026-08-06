import { InMemoryOutboxRepository } from "@growthos/db";
import { describe, expect, it, vi } from "vitest";
import { WarmthWorker } from "./warmth-worker.js";

const startDurableJetStreamConsumerMock = vi.hoisted(() => vi.fn());

vi.mock("@growthos/core", () => ({
  startDurableJetStreamConsumer: startDurableJetStreamConsumerMock,
}));

import { startWarmthSignalConsumer } from "./index.js";

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

describe("warmth durable runtime", () => {
  it("uses the tenant-scoped signal stream and persists retry exhaustion", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const worker = new WarmthWorker({
      outboxRepository,
      now: () => new Date("2026-04-28T00:00:00.000Z"),
    });

    await startWarmthSignalConsumer(worker, outboxRepository);

    const { config, handler, hooks } = registeredConsumer();
    expect(config).toMatchObject({
      subject: "t.*.warmth.signal.v1",
      durableName: "growthos_warmth",
      queueGroup: "growthos-worker-warmth",
      maxDeliver: 5,
    });

    const context = {
      subject: `t.${tenantId}.warmth.signal.v1`,
      streamSequence: 84,
      redeliveryCount: 5,
    };
    await handler(
      {
        tenant_id: tenantId,
        warmth_id: "warm-runtime-1",
        dedupe_key: "warm-runtime-1",
        source: "warmth_builder",
        subject_id: "subject-runtime-1",
        cold_override: false,
        touches: [
          {
            touch_type: "reply",
            occurred_at: "2026-04-27T00:00:00.000Z",
          },
        ],
      },
      context,
    );

    if (!hooks.onExhausted) {
      throw new Error("Expected an exhausted-message handler.");
    }
    await hooks.onExhausted(
      { warmth_id: "bad-warmth" },
      context,
      new Error("invalid warmth signal"),
    );

    const events = await outboxRepository.listUnconsumed(tenantId, 10);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.eventType)).toEqual([
      "warmth.evaluated.v1",
      "worker.dead_lettered.v1",
    ]);
    expect(events[1]?.payload).toMatchObject({
      worker: "warmth",
      stream_sequence: 84,
      redelivery_count: 5,
    });
  });
});
