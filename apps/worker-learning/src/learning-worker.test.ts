import { InMemoryOutboxRepository } from "@growthos/db";
import { describe, expect, it, vi } from "vitest";
import {
  type EventPublisher,
  LearningWorker,
  synthesizeLearningCandidate,
} from "./learning-worker.js";

const tenantId = "00000000-0000-4000-8000-000000000001";

describe("synthesizeLearningCandidate", () => {
  it("returns high-priority candidate for rejected feedback", () => {
    const result = synthesizeLearningCandidate({
      tenantId,
      learningId: "learn-1",
      dedupeKey: "learn-1",
      source: "approval_feedback",
      issueId: "00000000-0000-4000-8000-000000000101",
      outputType: "content_brief.v1",
      action: "rejected",
      rubricFailures: ["missing evidence"],
      learnOptIn: true,
    });

    expect(result.disposition).toBe("candidate");
    expect(result.priority).toBe("high");
  });

  it("discards when founder opts out of learning capture", () => {
    const result = synthesizeLearningCandidate({
      tenantId,
      learningId: "learn-2",
      dedupeKey: "learn-2",
      source: "approval_feedback",
      issueId: "00000000-0000-4000-8000-000000000102",
      outputType: "blog_draft.v1",
      action: "approved",
      rubricFailures: [],
      learnOptIn: false,
    });

    expect(result.disposition).toBe("discarded");
    expect(result.priority).toBe("low");
  });
});

describe("LearningWorker", () => {
  it("emits synthesized learning candidate event into outbox and tenant subject", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const eventPublisher: EventPublisher = {
      publish: vi.fn(async () => undefined),
    };
    const worker = new LearningWorker({ outboxRepository, eventPublisher });

    const result = await worker.process({
      tenantId,
      learningId: "learn-1",
      dedupeKey: "learn-1",
      source: "approval_feedback",
      issueId: "00000000-0000-4000-8000-000000000101",
      outputType: "content_brief.v1",
      action: "edited_then_approved",
      editDistance: 0.32,
      rubricFailures: [],
      learnOptIn: true,
    });

    expect(result.disposition).toBe("candidate");
    expect(eventPublisher.publish).toHaveBeenCalledWith(
      `t.${tenantId}.learning.candidate.synthesized.v1`,
      expect.objectContaining({
        learning_id: "learn-1",
        disposition: "candidate",
      }),
    );

    const events = await outboxRepository.listUnconsumed(tenantId, 10);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("learning.candidate.synthesized.v1");
  });

  it("keeps outbox idempotent for duplicate learning signals", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const worker = new LearningWorker({
      outboxRepository,
      eventPublisher: { publish: vi.fn(async () => undefined) },
    });

    const request = {
      tenantId,
      learningId: "learn-dup-1",
      dedupeKey: "dedupe-learning-1",
      source: "approval_feedback",
      issueId: "00000000-0000-4000-8000-000000000103",
      outputType: "weekly_review.v1",
      action: "approved" as const,
      editDistance: 0.04,
      rubricFailures: [],
      learnOptIn: true,
    };

    await worker.process(request);
    await worker.process(request);

    const events = await outboxRepository.listUnconsumed(tenantId, 10);
    expect(events).toHaveLength(1);
  });
});
