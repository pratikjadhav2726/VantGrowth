import { InMemoryOutboxRepository } from "@growthos/db";
import { describe, expect, it, vi } from "vitest";
import {
  type EventPublisher,
  SignalRouter,
  classifySignal,
} from "./signal-router.js";

const tenantId = "00000000-0000-4000-8000-000000000001";

describe("classifySignal", () => {
  it("routes known high-value signals deterministically", () => {
    const result = classifySignal({
      tenantId,
      signalId: "sig-1",
      dedupeKey: "sig-1",
      source: "webhook.hubspot",
      kind: "prospect.replied",
      payload: {},
    });

    expect(result.priority).toBe("P0");
    expect(result.targetAgent).toBe("warm_outbound_researcher");
  });
});

describe("SignalRouter", () => {
  it("emits routed signal to outbox and tenant-scoped NATS subject", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const eventPublisher: EventPublisher = {
      publish: vi.fn(async () => undefined),
    };

    const router = new SignalRouter({ outboxRepository, eventPublisher });
    const routed = await router.route({
      tenantId,
      signalId: "sig-1",
      dedupeKey: "sig-1",
      source: "competitor.watch",
      kind: "competitor.pricing_change",
      payload: { competitor: "LaunchDarkly" },
    });

    expect(routed.priority).toBe("P1");
    expect(eventPublisher.publish).toHaveBeenCalledWith(
      `t.${tenantId}.signal.routed.v1`,
      expect.objectContaining({
        signal_id: "sig-1",
        target_agent: "intel_director",
      }),
    );

    const events = await outboxRepository.listUnconsumed(tenantId, 10);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("signal.routed.v1");
  });

  it("keeps outbox idempotent across duplicate signal deliveries", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const router = new SignalRouter({
      outboxRepository,
      eventPublisher: { publish: vi.fn(async () => undefined) },
    });

    const signal = {
      tenantId,
      signalId: "sig-1",
      dedupeKey: "dedupe-1",
      source: "competitor.watch",
      kind: "competitor.pricing_change",
      payload: { competitor: "LaunchDarkly" },
    };

    await router.route(signal);
    await router.route(signal);

    const events = await outboxRepository.listUnconsumed(tenantId, 10);
    expect(events).toHaveLength(1);
  });
});
