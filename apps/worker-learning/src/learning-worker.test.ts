import {
  InMemoryLearningProposalRepository,
  InMemoryOutboxRepository,
  InMemoryPlaybookVersionsRepository,
} from "@growthos/db";
import { describe, expect, it, vi } from "vitest";
import {
  type EventPublisher,
  LearningWorker,
  type PromotionEvidenceProvider,
  buildUpdatedRubricContent,
  synthesizeLearningCandidate,
} from "./learning-worker.js";

const tenantId = "00000000-0000-4000-8000-000000000001";
const otherTenantId = "00000000-0000-4000-8000-000000000002";

const makeCritiquePayload = (
  overrides: Partial<{
    critique_id: string;
    artifact_kind: string;
    artifact_id: string;
    verdict: "approve" | "revise" | "reject";
    reasons: string[];
    confidence_score: number;
    experiment_id: string;
    change_risk: "low" | "medium" | "high" | "critical";
  }> = {},
) => ({
  critique_id:
    overrides.critique_id ?? "crit-00000000-0000-4000-8000-000000000001",
  source: "worker-critique",
  artifact_kind: overrides.artifact_kind ?? "blog_draft.v1",
  artifact_id: overrides.artifact_id ?? "art-00000001",
  ...(overrides.experiment_id
    ? { experiment_id: overrides.experiment_id }
    : {}),
  ...(overrides.change_risk ? { change_risk: overrides.change_risk } : {}),
  prompt_version: "1.0.0",
  verdict: overrides.verdict ?? "revise",
  confidence_score: overrides.confidence_score ?? 0.68,
  reasons: overrides.reasons ?? [
    "Missing call to action",
    "No statistics cited",
  ],
  critiqued_at: "2026-04-28T10:00:00.000Z",
});

// ---------------------------------------------------------------------------
// synthesizeLearningCandidate (heuristic path — unchanged)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// buildUpdatedRubricContent
// ---------------------------------------------------------------------------

describe("buildUpdatedRubricContent", () => {
  it("falls back to DEFAULT_RUBRIC_CONTENT when no existing content", () => {
    const { content, addedCriteria } = buildUpdatedRubricContent(
      undefined,
      ["Missing CTA"],
      1000,
    );
    // Default rubric has 4 criteria + 1 new one
    expect(content.rubric).toHaveLength(5);
    expect(addedCriteria).toHaveLength(1);
    expect(addedCriteria[0]?.description).toBe("Missing CTA");
  });

  it("appends to existing valid rubric", () => {
    const existing = {
      rubric: [
        { id: "r1", weight: 0.5, description: "Has CTA", check: "has_cta" },
        {
          id: "r2",
          weight: 0.5,
          description: "Has evidence",
          check: "has_evidence",
        },
      ],
    };
    const { content, addedCriteria } = buildUpdatedRubricContent(
      existing,
      ["Too short", "No headings"],
      2000,
    );
    expect(content.rubric).toHaveLength(4);
    expect(addedCriteria).toHaveLength(2);
    expect(addedCriteria[0]?.check).toBe("custom");
    expect(addedCriteria[0]?.weight).toBe(0.1);
  });

  it("preserves min/max word count and forbidden phrases from existing rubric", () => {
    const existing = {
      rubric: [{ id: "r1", weight: 1.0, description: "ok", check: "has_cta" }],
      min_word_count: 300,
      max_word_count: 2000,
      forbidden_phrases: ["synergy"],
    };
    const { content } = buildUpdatedRubricContent(existing, ["reason"]);
    expect(content.min_word_count).toBe(300);
    expect(content.max_word_count).toBe(2000);
    expect(content.forbidden_phrases).toEqual(["synergy"]);
  });

  it("truncates descriptions longer than 120 chars", () => {
    const longReason = "A".repeat(130);
    const { content } = buildUpdatedRubricContent(
      undefined,
      [longReason],
      3000,
    );
    const added = content.rubric.find((c) => c.id.startsWith("auto-3000"));
    expect(added?.description).toHaveLength(120);
    expect(added?.description).toMatch(/\.\.\.$/);
  });

  it("returns empty addedCriteria when reasons array is empty", () => {
    const { addedCriteria } = buildUpdatedRubricContent(undefined, [], 4000);
    expect(addedCriteria).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// LearningWorker — approval-feedback path (existing)
// ---------------------------------------------------------------------------

describe("LearningWorker.process", () => {
  it("emits synthesized learning candidate event into the outbox only", async () => {
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
    expect(eventPublisher.publish).not.toHaveBeenCalled();

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

// ---------------------------------------------------------------------------
// LearningWorker.processFromCritique — playbook feedback path
// ---------------------------------------------------------------------------

describe("LearningWorker.processFromCritique", () => {
  const makeWorker = (
    playbookRepository?: InMemoryPlaybookVersionsRepository,
    promotionEnabled = true,
  ) => {
    const outboxRepository = new InMemoryOutboxRepository();
    const eventPublisher: EventPublisher = {
      publish: vi.fn(async () => undefined),
    };
    const promotionEvidenceProvider: PromotionEvidenceProvider = {
      getEvaluation: async (proposal) => ({
        proposalId: proposal.proposalId,
        risk: "low" as const,
        evidenceCount: 30,
        uniqueEntities: 20,
        confidence: 0.95,
        metricDirection: "increase" as const,
        baselineMetric: 0.1,
        candidateMetric: 0.12,
        worstGuardrailRegression: 0,
        humanApproved: false,
      }),
    };
    const worker = new LearningWorker({
      outboxRepository,
      eventPublisher,
      ...(playbookRepository ? { playbookRepository } : {}),
      ...(playbookRepository && promotionEnabled
        ? { promotionEvidenceProvider }
        : {}),
    });
    return { worker, outboxRepository, eventPublisher };
  };

  it("returns null when no playbookRepository is configured", async () => {
    const { worker } = makeWorker();
    const result = await worker.processFromCritique(
      tenantId,
      makeCritiquePayload(),
    );
    expect(result).toBeNull();
  });

  it("records a proposal but does not mutate a playbook without promotion evidence", async () => {
    const playbookRepo = new InMemoryPlaybookVersionsRepository();
    const { worker, outboxRepository } = makeWorker(playbookRepo, false);

    const result = await worker.processFromCritique(
      tenantId,
      makeCritiquePayload({ verdict: "revise" }),
    );

    expect(result).toBeNull();
    expect(await playbookRepo.getActive(tenantId, "blog_draft")).toBeNull();
    const events = await outboxRepository.listUnconsumed(tenantId, 10);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("learning.playbook.change.proposed.v1");
  });

  it("persists every corrective proposal as awaiting evidence before it can mutate a playbook", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const proposalRepository = new InMemoryLearningProposalRepository();
    const worker = new LearningWorker({
      outboxRepository,
      playbookRepository: new InMemoryPlaybookVersionsRepository(),
      learningProposalRepository: proposalRepository,
    });

    await worker.processFromCritique(
      tenantId,
      makeCritiquePayload({
        critique_id: "crit-persisted-awaiting-evidence",
        verdict: "revise",
      }),
    );

    const proposal = await proposalRepository.getByProposalKey(
      tenantId,
      "critique:crit-persisted-awaiting-evidence",
    );
    expect(proposal).toMatchObject({
      targetType: "blog_draft",
      targetId: "art-00000001",
      risk: "high",
      status: "awaiting_evidence",
      experimentId: null,
    });

    const events = await outboxRepository.listUnconsumed(tenantId, 10);
    expect(events[0]?.payload).toMatchObject({
      proposal_id: "critique:crit-persisted-awaiting-evidence",
      learning_proposal_id: proposal?.id,
      change_risk: "high",
    });
  });

  it("records an evidence pass for a high-risk change as requiring founder approval", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const proposalRepository = new InMemoryLearningProposalRepository();
    const worker = new LearningWorker({
      outboxRepository,
      playbookRepository: new InMemoryPlaybookVersionsRepository(),
      learningProposalRepository: proposalRepository,
      promotionEvidenceProvider: {
        getEvaluation: async (proposal) => ({
          proposalId: proposal.proposalId,
          risk: "high",
          evidenceCount: 30,
          uniqueEntities: 20,
          confidence: 0.95,
          metricDirection: "increase",
          baselineMetric: 0.1,
          candidateMetric: 0.12,
          worstGuardrailRegression: 0,
          humanApproved: false,
        }),
      },
    });

    const result = await worker.processFromCritique(
      tenantId,
      makeCritiquePayload({
        critique_id: "crit-requires-founder",
        verdict: "revise",
        change_risk: "high",
      }),
    );

    expect(result).toBeNull();
    const proposal = await proposalRepository.getByProposalKey(
      tenantId,
      "critique:crit-requires-founder",
    );
    expect(proposal).toMatchObject({
      status: "requires_approval",
      decision: "requires_approval",
      humanApprovedAt: null,
    });
  });

  it("re-reads evidence after founder approval before promoting a high-risk proposal", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const proposalRepository = new InMemoryLearningProposalRepository();
    const playbookRepository = new InMemoryPlaybookVersionsRepository();
    let humanApproved = false;
    const worker = new LearningWorker({
      outboxRepository,
      playbookRepository,
      learningProposalRepository: proposalRepository,
      promotionEvidenceProvider: {
        getEvaluation: async (proposal) => ({
          proposalId: proposal.proposalId,
          risk: "high",
          evidenceCount: 30,
          uniqueEntities: 20,
          confidence: 0.95,
          metricDirection: "increase",
          baselineMetric: 0.1,
          candidateMetric: 0.12,
          worstGuardrailRegression: 0,
          humanApproved,
        }),
      },
    });

    await worker.processFromCritique(
      tenantId,
      makeCritiquePayload({
        critique_id: "crit-founder-recheck",
        verdict: "revise",
        change_risk: "high",
      }),
    );
    const pending = await proposalRepository.getByProposalKey(
      tenantId,
      "critique:crit-founder-recheck",
    );
    expect(pending?.status).toBe("requires_approval");

    const approved = await proposalRepository.approve(
      tenantId,
      pending?.id ?? "",
      "founder@example.test",
    );
    expect(approved?.status).toBe("approved");
    humanApproved = true;

    // Duplicate outbox deliveries may both re-read the approved proposal.
    // The proposal lease lets exactly one of them create the immutable version.
    const [version, duplicate] = await Promise.all([
      worker.processApprovedProposal(tenantId, pending?.id ?? ""),
      worker.processApprovedProposal(tenantId, pending?.id ?? ""),
    ]);
    expect([version, duplicate].filter(Boolean)).toHaveLength(1);
    const promotedVersion = version ?? duplicate;
    expect(promotedVersion).not.toBeNull();
    expect(
      await playbookRepository.listAll(tenantId, "blog_draft"),
    ).toHaveLength(1);

    const promoted = await proposalRepository.getByProposalKey(
      tenantId,
      "critique:crit-founder-recheck",
    );
    expect(promoted).toMatchObject({
      status: "promoted",
      humanApprovedBy: "founder@example.test",
      promotedVersionRef: promotedVersion?.id,
    });
  });

  it("only marks a low-risk proposal promoted after durable evidence passes", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const proposalRepository = new InMemoryLearningProposalRepository();
    const worker = new LearningWorker({
      outboxRepository,
      playbookRepository: new InMemoryPlaybookVersionsRepository(),
      learningProposalRepository: proposalRepository,
      promotionEvidenceProvider: {
        getEvaluation: async (proposal) => ({
          proposalId: proposal.proposalId,
          risk: "low",
          evidenceCount: 30,
          uniqueEntities: 20,
          confidence: 0.95,
          metricDirection: "increase",
          baselineMetric: 0.1,
          candidateMetric: 0.12,
          worstGuardrailRegression: 0,
          humanApproved: false,
        }),
      },
    });

    const version = await worker.processFromCritique(
      tenantId,
      makeCritiquePayload({
        critique_id: "crit-low-risk-promoted",
        verdict: "revise",
        change_risk: "low",
      }),
    );

    expect(version).not.toBeNull();
    const proposal = await proposalRepository.getByProposalKey(
      tenantId,
      "critique:crit-low-risk-promoted",
    );
    expect(proposal).toMatchObject({
      status: "promoted",
      decision: "promote",
      promotedVersionRef: version?.id,
    });
  });

  it("replays a created version when its durable update event initially fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T12:00:00.000Z"));

    const outboxRepository = new InMemoryOutboxRepository();
    const originalEnqueue = outboxRepository.enqueue.bind(outboxRepository);
    let rejectUpdateOnce = true;
    const enqueueSpy = vi
      .spyOn(outboxRepository, "enqueue")
      .mockImplementation(async (command) => {
        if (
          rejectUpdateOnce &&
          command.eventType === "learning.playbook.updated.v1"
        ) {
          rejectUpdateOnce = false;
          throw new Error("simulated update outbox outage");
        }
        return originalEnqueue(command);
      });

    try {
      const proposalRepository = new InMemoryLearningProposalRepository();
      const playbookRepository = new InMemoryPlaybookVersionsRepository();
      const worker = new LearningWorker({
        outboxRepository,
        playbookRepository,
        learningProposalRepository: proposalRepository,
        promotionEvidenceProvider: {
          getEvaluation: async (proposal) => ({
            proposalId: proposal.proposalId,
            risk: "low",
            evidenceCount: 30,
            uniqueEntities: 20,
            confidence: 0.95,
            metricDirection: "increase",
            baselineMetric: 0.1,
            candidateMetric: 0.12,
            worstGuardrailRegression: 0,
            humanApproved: false,
          }),
        },
      });

      await expect(
        worker.processFromCritique(
          tenantId,
          makeCritiquePayload({
            critique_id: "crit-update-event-replay",
            verdict: "revise",
            change_risk: "low",
          }),
        ),
      ).rejects.toThrow("simulated update outbox outage");

      const pending = await proposalRepository.getByProposalKey(
        tenantId,
        "critique:crit-update-event-replay",
      );
      expect(pending?.status).toBe("approved");
      expect(
        await playbookRepository.listAll(tenantId, "blog_draft"),
      ).toHaveLength(1);
      expect(
        await outboxRepository.listByEventType(
          tenantId,
          "learning.playbook.updated.v1",
          10,
        ),
      ).toHaveLength(0);

      // The failed claimant's lease expires; the replay finds the immutable
      // version, writes the missing event idempotently, then marks promoted.
      vi.advanceTimersByTime(60_001);
      const replayed = await worker.processApprovedProposal(
        tenantId,
        pending?.id ?? "",
      );
      expect(replayed).not.toBeNull();
      expect(
        await outboxRepository.listByEventType(
          tenantId,
          "learning.playbook.updated.v1",
          10,
        ),
      ).toHaveLength(1);
      expect(
        (
          await proposalRepository.getByProposalKey(
            tenantId,
            "critique:crit-update-event-replay",
          )
        )?.status,
      ).toBe("promoted");
      expect(
        await playbookRepository.listAll(tenantId, "blog_draft"),
      ).toHaveLength(1);
    } finally {
      enqueueSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("returns null for 'approve' verdict (no corrective signal)", async () => {
    const { worker } = makeWorker(new InMemoryPlaybookVersionsRepository());
    const result = await worker.processFromCritique(
      tenantId,
      makeCritiquePayload({ verdict: "approve" }),
    );
    expect(result).toBeNull();
  });

  it("returns null for artifact kinds with no playbook type mapping", async () => {
    const { worker } = makeWorker(new InMemoryPlaybookVersionsRepository());
    const result = await worker.processFromCritique(
      tenantId,
      makeCritiquePayload({ artifact_kind: "unknown_artifact.v99" }),
    );
    expect(result).toBeNull();
  });

  it("creates a new playbook version from critique failure reasons (no existing playbook)", async () => {
    const playbookRepo = new InMemoryPlaybookVersionsRepository();
    const { worker } = makeWorker(playbookRepo);

    const result = await worker.processFromCritique(
      tenantId,
      makeCritiquePayload({
        verdict: "revise",
        reasons: ["Missing CTA", "No statistics"],
        artifact_kind: "blog_draft.v1",
      }),
    );

    expect(result).not.toBeNull();
    expect(result?.playbookType).toBe("blog_draft");
    expect(result?.version).toBe(1);
    // Default rubric (4) + 2 new criteria = 6
    const content = result?.content as { rubric: unknown[] };
    expect(content.rubric).toHaveLength(6);
  });

  it("builds on the existing active playbook when one exists", async () => {
    const playbookRepo = new InMemoryPlaybookVersionsRepository();
    await playbookRepo.create(tenantId, {
      playbookType: "blog_draft",
      name: "Blog Draft Rubric v1",
      content: {
        rubric: [
          { id: "r1", weight: 0.5, description: "Has CTA", check: "has_cta" },
          {
            id: "r2",
            weight: 0.5,
            description: "Has evidence",
            check: "has_evidence",
          },
        ],
      },
      createdBy: "seed",
    });

    const { worker } = makeWorker(playbookRepo);
    const result = await worker.processFromCritique(
      tenantId,
      makeCritiquePayload({ verdict: "reject", reasons: ["Too short"] }),
    );

    const content = result?.content as { rubric: unknown[] };
    // 2 existing + 1 new = 3
    expect(content.rubric).toHaveLength(3);
  });

  it("emits learning.playbook.updated.v1 to outbox + NATS on revise verdict", async () => {
    const playbookRepo = new InMemoryPlaybookVersionsRepository();
    const { worker, outboxRepository, eventPublisher } =
      makeWorker(playbookRepo);

    await worker.processFromCritique(
      tenantId,
      makeCritiquePayload({ verdict: "revise", critique_id: "crit-abc" }),
    );

    const events = await outboxRepository.listUnconsumed(tenantId, 10);
    const updated = events.find(
      (event) => event.eventType === "learning.playbook.updated.v1",
    );
    expect(events).toHaveLength(2);
    expect(updated?.payload?.critique_id).toBe("crit-abc");

    expect(eventPublisher.publish).not.toHaveBeenCalled();
  });

  it("emits learning.playbook.updated.v1 on reject verdict", async () => {
    const playbookRepo = new InMemoryPlaybookVersionsRepository();
    const { worker, outboxRepository } = makeWorker(playbookRepo);

    await worker.processFromCritique(
      tenantId,
      makeCritiquePayload({ verdict: "reject", critique_id: "crit-rej-1" }),
    );

    const events = await outboxRepository.listUnconsumed(tenantId, 10);
    const updated = events.find(
      (event) => event.eventType === "learning.playbook.updated.v1",
    );
    expect(updated?.payload?.verdict).toBe("reject");
  });

  it("maps content_brief.v1 artifact kind to content_brief playbook type", async () => {
    const playbookRepo = new InMemoryPlaybookVersionsRepository();
    const { worker } = makeWorker(playbookRepo);

    const result = await worker.processFromCritique(
      tenantId,
      makeCritiquePayload({
        artifact_kind: "content_brief.v1",
        verdict: "revise",
      }),
    );

    expect(result?.playbookType).toBe("content_brief");
  });

  it("maps intel_brief.v1 artifact kind to intel_brief playbook type", async () => {
    const playbookRepo = new InMemoryPlaybookVersionsRepository();
    const { worker } = makeWorker(playbookRepo);

    const result = await worker.processFromCritique(
      tenantId,
      makeCritiquePayload({
        artifact_kind: "intel_brief.v1",
        verdict: "revise",
      }),
    );

    expect(result?.playbookType).toBe("intel_brief");
  });

  it("is idempotent: duplicate critique_id produces only one outbox event", async () => {
    const playbookRepo = new InMemoryPlaybookVersionsRepository();
    const { worker, outboxRepository } = makeWorker(playbookRepo);

    const payload = makeCritiquePayload({
      critique_id: "crit-idem-1",
      verdict: "revise",
    });
    await worker.processFromCritique(tenantId, payload);
    await worker.processFromCritique(tenantId, payload);

    const events = await outboxRepository.listUnconsumed(tenantId, 10);
    // Outbox deduplication: only one row per idempotencyKey
    const playbookEvents = events.filter(
      (e) => e.eventType === "learning.playbook.updated.v1",
    );
    expect(playbookEvents).toHaveLength(1);
  });

  it("is tenant-scoped: other tenant's playbook is not affected", async () => {
    const playbookRepo = new InMemoryPlaybookVersionsRepository();
    const { worker } = makeWorker(playbookRepo);

    await worker.processFromCritique(
      tenantId,
      makeCritiquePayload({ verdict: "revise" }),
    );

    const otherPlaybook = await playbookRepo.getActive(
      otherTenantId,
      "blog_draft",
    );
    expect(otherPlaybook).toBeNull();
  });

  it("records criteria_added count in the emitted event payload", async () => {
    const playbookRepo = new InMemoryPlaybookVersionsRepository();
    const { worker, outboxRepository } = makeWorker(playbookRepo);

    await worker.processFromCritique(
      tenantId,
      makeCritiquePayload({ verdict: "revise", reasons: ["A", "B", "C"] }),
    );

    const events = await outboxRepository.listUnconsumed(tenantId, 10);
    const updated = events.find(
      (event) => event.eventType === "learning.playbook.updated.v1",
    );
    expect(updated?.payload?.criteria_added).toBe(3);
  });

  it("rejects invalid payload at parse boundary", async () => {
    const playbookRepo = new InMemoryPlaybookVersionsRepository();
    const { worker } = makeWorker(playbookRepo);

    await expect(
      worker.processFromCritique(tenantId, { not: "a valid payload" }),
    ).rejects.toThrow();
  });
});
