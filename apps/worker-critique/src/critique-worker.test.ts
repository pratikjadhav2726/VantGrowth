import { InMemoryOutboxRepository } from "@growthos/db";
import { describe, expect, it, vi } from "vitest";
import {
  CritiqueWorker,
  type EventPublisher,
  scoreCritique,
} from "./critique-worker.js";

const tenantId = "00000000-0000-4000-8000-000000000001";

describe("scoreCritique", () => {
  it("returns revise when reviewer notes are present", () => {
    const result = scoreCritique({
      tenantId,
      critiqueId: "crit-1",
      dedupeKey: "crit-1",
      source: "worker-heartbeat",
      artifactKind: "blog_draft.v1",
      artifactId: "artifact-1",
      promptVersion: "v1",
      candidateOutput: "Concise copy that still needs citations.",
      reviewerNotes: ["missing source links"],
    });

    expect(result.verdict).toBe("revise");
    expect(result.confidenceScore).toBeLessThan(0.7);
  });
});

describe("CritiqueWorker", () => {
  it("emits critique completion event into outbox and tenant-scoped subject", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const eventPublisher: EventPublisher = {
      publish: vi.fn(async () => undefined),
    };

    const worker = new CritiqueWorker({ outboxRepository, eventPublisher });
    const result = await worker.critique({
      tenantId,
      critiqueId: "crit-1",
      dedupeKey: "crit-1",
      source: "worker-heartbeat",
      artifactKind: "blog_draft.v1",
      artifactId: "artifact-1",
      promptVersion: "v1",
      candidateOutput:
        "This draft includes clear sections, supporting claims, concise narrative flow, concrete customer evidence, and explicit CTA language tuned to the target channel so it can pass a quality gate without requiring immediate revision.",
      reviewerNotes: [],
    });

    expect(result.verdict).toBe("approve");
    expect(eventPublisher.publish).toHaveBeenCalledWith(
      `t.${tenantId}.critique.completed.v1`,
      expect.objectContaining({
        critique_id: "crit-1",
        verdict: "approve",
      }),
    );

    const events = await outboxRepository.listUnconsumed(tenantId, 10);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("critique.completed.v1");
  });

  it("keeps outbox idempotent for duplicate critiques", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const worker = new CritiqueWorker({
      outboxRepository,
      eventPublisher: { publish: vi.fn(async () => undefined) },
    });

    const request = {
      tenantId,
      critiqueId: "crit-1",
      dedupeKey: "dedupe-1",
      source: "worker-heartbeat",
      artifactKind: "blog_draft.v1",
      artifactId: "artifact-1",
      promptVersion: "v1",
      candidateOutput: "Short text that triggers revise.",
      reviewerNotes: ["add more evidence"],
    };

    await worker.critique(request);
    await worker.critique(request);

    const events = await outboxRepository.listUnconsumed(tenantId, 10);
    expect(events).toHaveLength(1);
  });
});
