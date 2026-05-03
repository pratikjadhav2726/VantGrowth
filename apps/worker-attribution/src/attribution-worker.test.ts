import { InMemoryOutboxRepository } from "@growthos/db";
import { describe, expect, it, vi } from "vitest";
import {
  AttributionWorker,
  type EventPublisher,
  synthesizeAttributionRollup,
} from "./attribution-worker.js";

const tenantId = "00000000-0000-4000-8000-000000000001";

describe("synthesizeAttributionRollup", () => {
  it("computes touchpoint totals and top channel", () => {
    const result = synthesizeAttributionRollup({
      tenantId,
      attributionId: "attr-1",
      dedupeKey: "attr-1",
      source: "nightly_rollup",
      opportunityId: "opp-1",
      accountId: "acct-1",
      window: "30d",
      touchpoints: [
        {
          channel: "linkedin",
          eventType: "message_opened",
          occurredAt: new Date("2026-04-01T00:00:00.000Z"),
        },
        {
          channel: "email",
          eventType: "email_clicked",
          occurredAt: new Date("2026-04-02T00:00:00.000Z"),
        },
        {
          channel: "linkedin",
          eventType: "reply_received",
          occurredAt: new Date("2026-04-03T00:00:00.000Z"),
        },
      ],
      conversionValueMicros: 2_500_000,
    });

    expect(result.totalTouchpoints).toBe(3);
    expect(result.uniqueChannels).toBe(2);
    expect(result.topChannel).toBe("linkedin");
  });
});

describe("AttributionWorker", () => {
  it("emits attribution rollup event into outbox and tenant subject", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const eventPublisher: EventPublisher = {
      publish: vi.fn(async () => undefined),
    };
    const worker = new AttributionWorker({ outboxRepository, eventPublisher });

    const result = await worker.process({
      tenantId,
      attributionId: "attr-1",
      dedupeKey: "attr-1",
      source: "nightly_rollup",
      opportunityId: "opp-1",
      accountId: "acct-1",
      window: "30d",
      touchpoints: [
        {
          channel: "email",
          eventType: "email_opened",
          occurredAt: new Date("2026-04-02T00:00:00.000Z"),
        },
      ],
      conversionValueMicros: 5_000_000,
    });

    expect(result.totalTouchpoints).toBe(1);
    expect(eventPublisher.publish).toHaveBeenCalledWith(
      `t.${tenantId}.attribution.rollup.computed.v1`,
      expect.objectContaining({
        attribution_id: "attr-1",
        total_touchpoints: 1,
      }),
    );

    const events = await outboxRepository.listUnconsumed(tenantId, 10);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("attribution.rollup.computed.v1");
  });

  it("keeps outbox idempotent for duplicate attribution signals", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const worker = new AttributionWorker({
      outboxRepository,
      eventPublisher: { publish: vi.fn(async () => undefined) },
    });

    const request = {
      tenantId,
      attributionId: "attr-dup-1",
      dedupeKey: "dedupe-attr-1",
      source: "nightly_rollup",
      opportunityId: "opp-2",
      accountId: "acct-2",
      window: "60d" as const,
      touchpoints: [
        {
          channel: "reddit",
          eventType: "mention_clicked",
          occurredAt: new Date("2026-04-02T00:00:00.000Z"),
        },
      ],
      conversionValueMicros: 1_000_000,
    };

    await worker.process(request);
    await worker.process(request);

    const events = await outboxRepository.listUnconsumed(tenantId, 10);
    expect(events).toHaveLength(1);
  });
});
