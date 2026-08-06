import { InMemoryOutboxRepository } from "@growthos/db";
import { describe, expect, it } from "vitest";
import {
  AttributionWorker,
  synthesizeAttributionRollup,
} from "./attribution-worker.js";
import { parseAttributionSignalEvent } from "./contracts.js";

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

describe("parseAttributionSignalEvent", () => {
  const eventPayload = {
    tenant_id: tenantId,
    attribution_id: "attr-wire-1",
    dedupe_key: "attr-wire-1",
    source: "nightly_rollup",
    opportunity_id: "opp-wire-1",
    account_id: "acct-wire-1",
    window: "30d" as const,
    touchpoints: [
      {
        channel: "email",
        campaign_id: "campaign-1",
        event_type: "email_opened",
        occurred_at: "2026-04-02T00:00:00.000Z",
      },
    ],
    conversion_value_micros: 5_000_000,
  };

  it("normalizes the durable snake_case event contract", () => {
    const signal = parseAttributionSignalEvent(eventPayload, tenantId);

    expect(signal).toMatchObject({
      tenantId,
      attributionId: "attr-wire-1",
      dedupeKey: "attr-wire-1",
      opportunityId: "opp-wire-1",
      conversionValueMicros: 5_000_000,
    });
    expect(signal.touchpoints[0]?.occurredAt).toEqual(
      new Date("2026-04-02T00:00:00.000Z"),
    );
  });

  it("rejects a payload that claims a different tenant", () => {
    expect(() =>
      parseAttributionSignalEvent(
        eventPayload,
        "00000000-0000-4000-8000-000000000002",
      ),
    ).toThrow("does not match");
  });
});

describe("AttributionWorker", () => {
  it("emits attribution rollup event into the durable outbox", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const worker = new AttributionWorker({ outboxRepository });

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
    const events = await outboxRepository.listUnconsumed(tenantId, 10);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("attribution.rollup.computed.v1");
    expect(events[0]?.payload).toMatchObject({
      tenant_id: tenantId,
      attribution_id: "attr-1",
      total_touchpoints: 1,
    });
  });

  it("keeps outbox idempotent for duplicate attribution signals", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const worker = new AttributionWorker({ outboxRepository });

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
