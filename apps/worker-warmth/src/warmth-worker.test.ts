import { InMemoryOutboxRepository } from "@growthos/db";
import { describe, expect, it, vi } from "vitest";
import {
  type EventPublisher,
  WarmthWorker,
  computeWarmthScore,
  evaluateWarmthSignal,
} from "./warmth-worker.js";

const tenantId = "00000000-0000-4000-8000-000000000001";

describe("computeWarmthScore", () => {
  it("returns higher score for strong fresh touches", () => {
    const now = new Date("2026-04-28T00:00:00.000Z");
    const score = computeWarmthScore(
      {
        tenantId,
        warmthId: "warm-1",
        dedupeKey: "warm-1",
        source: "warmth_builder",
        subjectId: "subject-1",
        coldOverride: false,
        touches: [
          {
            touchType: "reply",
            occurredAt: new Date("2026-04-27T00:00:00.000Z"),
          },
          {
            touchType: "linkedin_comment",
            occurredAt: new Date("2026-04-26T00:00:00.000Z"),
          },
        ],
      },
      now,
    );

    expect(score).toBeGreaterThan(0.3);
  });
});

describe("evaluateWarmthSignal", () => {
  it("blocks outbound when score below threshold and no override", () => {
    const now = new Date("2026-04-28T00:00:00.000Z");
    const evaluation = evaluateWarmthSignal(
      {
        tenantId,
        warmthId: "warm-2",
        dedupeKey: "warm-2",
        source: "warmth_builder",
        subjectId: "subject-2",
        coldOverride: false,
        touches: [
          {
            touchType: "linkedin_view",
            occurredAt: new Date("2026-03-01T00:00:00.000Z"),
          },
        ],
      },
      now,
    );

    expect(evaluation.disposition).toBe("blocked");
    expect(evaluation.nextTouchRecommendedAt).toBeInstanceOf(Date);
  });

  it("allows outbound with cold override even below threshold", () => {
    const now = new Date("2026-04-28T00:00:00.000Z");
    const evaluation = evaluateWarmthSignal(
      {
        tenantId,
        warmthId: "warm-3",
        dedupeKey: "warm-3",
        source: "warmth_builder",
        subjectId: "subject-3",
        coldOverride: true,
        touches: [
          {
            touchType: "linkedin_view",
            occurredAt: new Date("2026-03-01T00:00:00.000Z"),
          },
        ],
      },
      now,
    );

    expect(evaluation.disposition).toBe("eligible");
    expect(evaluation.rationale.join(" ")).toContain("Cold override");
  });
});

describe("WarmthWorker", () => {
  it("emits warmth evaluation event into outbox and tenant subject", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const eventPublisher: EventPublisher = {
      publish: vi.fn(async () => undefined),
    };
    const worker = new WarmthWorker({
      outboxRepository,
      eventPublisher,
      now: () => new Date("2026-04-28T00:00:00.000Z"),
    });

    const result = await worker.process({
      tenantId,
      warmthId: "warm-1",
      dedupeKey: "warm-1",
      source: "warmth_builder",
      subjectId: "subject-1",
      coldOverride: false,
      touches: [
        {
          touchType: "reply",
          occurredAt: new Date("2026-04-27T00:00:00.000Z"),
        },
      ],
    });

    expect(result.disposition).toBe("eligible");
    expect(eventPublisher.publish).toHaveBeenCalledWith(
      `t.${tenantId}.warmth.evaluated.v1`,
      expect.objectContaining({
        warmth_id: "warm-1",
        disposition: "eligible",
      }),
    );

    const events = await outboxRepository.listUnconsumed(tenantId, 10);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("warmth.evaluated.v1");
  });

  it("keeps outbox idempotent for duplicate warmth signals", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const worker = new WarmthWorker({
      outboxRepository,
      eventPublisher: { publish: vi.fn(async () => undefined) },
      now: () => new Date("2026-04-28T00:00:00.000Z"),
    });

    const request = {
      tenantId,
      warmthId: "warm-dup-1",
      dedupeKey: "dedupe-warm-1",
      source: "warmth_builder",
      subjectId: "subject-dup",
      coldOverride: false,
      touches: [
        {
          touchType: "content_read" as const,
          occurredAt: new Date("2026-04-27T00:00:00.000Z"),
        },
      ],
    };

    await worker.process(request);
    await worker.process(request);

    const events = await outboxRepository.listUnconsumed(tenantId, 10);
    expect(events).toHaveLength(1);
  });
});
