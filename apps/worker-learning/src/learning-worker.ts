import type {
  OutboxRepository,
  PlaybookVersionRecord,
  PlaybookVersionsRepository,
} from "@growthos/db";
import { tenantScopedSubject } from "@growthos/db";
import {
  type CritiqueCompletedPayload,
  type LearnerRubricContent,
  type LearnerRubricCriterion,
  type LearningCandidate,
  type LearningSignal,
  critiqueCompletedPayloadSchema,
  learnerRubricContentSchema,
  learningCandidateSchema,
  learningSignalSchema,
} from "./contracts.js";

export interface EventPublisher {
  publish(subject: string, payload: Record<string, unknown>): Promise<void>;
}

export interface LearningWorkerDependencies {
  outboxRepository: OutboxRepository;
  eventPublisher: EventPublisher;
  playbookRepository?: PlaybookVersionsRepository;
}

// ---------------------------------------------------------------------------
// Artifact kind → playbook type mapping
// ---------------------------------------------------------------------------

const ARTIFACT_KIND_TO_PLAYBOOK_TYPE: Record<
  string,
  "blog_draft" | "content_brief" | "intel_brief" | "custom" | undefined
> = {
  blog_draft: "blog_draft",
  "blog_draft.v1": "blog_draft",
  content_brief: "content_brief",
  "content_brief.v1": "content_brief",
  intel_brief: "intel_brief",
  "intel_brief.v1": "intel_brief",
  custom: "custom",
};

const resolvePlaybookType = (
  artifactKind: string,
): "blog_draft" | "content_brief" | "intel_brief" | "custom" | null => {
  // Exact lookup first, then prefix match.
  const exact = ARTIFACT_KIND_TO_PLAYBOOK_TYPE[artifactKind];
  if (exact) return exact;
  if (artifactKind.startsWith("blog_draft")) return "blog_draft";
  if (artifactKind.startsWith("content_brief")) return "content_brief";
  if (artifactKind.startsWith("intel_brief")) return "intel_brief";
  if (artifactKind.startsWith("custom")) return "custom";
  return null;
};

// ---------------------------------------------------------------------------
// Rubric update helpers
// ---------------------------------------------------------------------------

const DEFAULT_RUBRIC_CONTENT: LearnerRubricContent = {
  rubric: [
    {
      id: "default-has_cta",
      weight: 0.25,
      description: "Content includes a clear call to action",
      check: "has_cta",
    },
    {
      id: "default-has_evidence",
      weight: 0.25,
      description: "Content includes quantitative evidence or statistics",
      check: "has_evidence",
    },
    {
      id: "default-length_ok",
      weight: 0.25,
      description: "Content meets expected word count range",
      check: "length_ok",
    },
    {
      id: "default-has_headings",
      weight: 0.25,
      description: "Content uses markdown headings for structure",
      check: "has_headings",
    },
  ],
};

/**
 * Builds an updated rubric content by appending new corrective criteria
 * derived from critique failure reasons.  The update is additive —
 * existing criteria are preserved so the playbook's history is traceable.
 */
export const buildUpdatedRubricContent = (
  existingContent: Record<string, unknown> | undefined,
  failureReasons: string[],
  criteriaTimestamp: number = Date.now(),
): {
  content: LearnerRubricContent;
  addedCriteria: LearnerRubricCriterion[];
} => {
  const parsed = learnerRubricContentSchema.safeParse(existingContent);
  const baseline = parsed.success ? parsed.data : DEFAULT_RUBRIC_CONTENT;

  const existingIds = new Set(baseline.rubric.map((c) => c.id));

  const newCriteria: LearnerRubricCriterion[] = failureReasons
    .map((reason, i) => ({
      id: `auto-${criteriaTimestamp}-${i}`,
      weight: 0.1,
      // Truncate to 120 chars to keep JSONB tidy.
      description: reason.length > 120 ? `${reason.slice(0, 117)}...` : reason,
      check: "custom",
    }))
    .filter((c) => !existingIds.has(c.id));

  return {
    content: {
      rubric: [...baseline.rubric, ...newCriteria],
      ...(baseline.min_word_count !== undefined
        ? { min_word_count: baseline.min_word_count }
        : {}),
      ...(baseline.max_word_count !== undefined
        ? { max_word_count: baseline.max_word_count }
        : {}),
      ...(baseline.forbidden_phrases !== undefined
        ? { forbidden_phrases: baseline.forbidden_phrases }
        : {}),
    },
    addedCriteria: newCriteria,
  };
};

// ---------------------------------------------------------------------------
// Existing heuristic synthesizer (unchanged)
// ---------------------------------------------------------------------------

export const synthesizeLearningCandidate = (
  input: LearningSignal,
): Omit<LearningCandidate, keyof LearningSignal | "synthesizedAt"> => {
  if (!input.learnOptIn) {
    return {
      disposition: "discarded",
      priority: "low",
      confidenceScore: 0.15,
      reasons: [
        "Founder disabled learning capture for this approval decision.",
      ],
    };
  }

  if (input.action === "rejected" || input.rubricFailures.length > 0) {
    return {
      disposition: "candidate",
      priority: "high",
      confidenceScore: 0.82,
      reasons: [
        "Rejection/rubric failures provide direct corrective signal for playbook updates.",
      ],
    };
  }

  if (
    input.action === "edited_then_approved" &&
    (input.editDistance ?? 0) >= 0.15
  ) {
    return {
      disposition: "candidate",
      priority: "medium",
      confidenceScore: 0.69,
      reasons: [
        "Significant founder edits indicate an improvable generation pattern.",
      ],
    };
  }

  if (input.action === "approved" && (input.editDistance ?? 0) < 0.1) {
    return {
      disposition: "candidate",
      priority: "low",
      confidenceScore: 0.56,
      reasons: [
        "Low-edit approval confirms existing playbook behavior for this output type.",
      ],
    };
  }

  return {
    disposition: "discarded",
    priority: "low",
    confidenceScore: 0.24,
    reasons: ["Signal quality is below learning candidate thresholds."],
  };
};

// ---------------------------------------------------------------------------
// LearningWorker
// ---------------------------------------------------------------------------

export class LearningWorker {
  constructor(private readonly deps: LearningWorkerDependencies) {}

  // ── Approval-feedback path (existing) ───────────────────────────────────

  async process(input: LearningSignal): Promise<LearningCandidate> {
    const signal = learningSignalSchema.parse(input);
    const candidate = learningCandidateSchema.parse({
      ...signal,
      ...synthesizeLearningCandidate(signal),
      synthesizedAt: new Date(),
    });

    const payload = {
      learning_id: candidate.learningId,
      source: candidate.source,
      issue_id: candidate.issueId,
      output_type: candidate.outputType,
      action: candidate.action,
      disposition: candidate.disposition,
      priority: candidate.priority,
      confidence_score: candidate.confidenceScore,
      reasons: candidate.reasons,
      rubric_failures: candidate.rubricFailures,
      edit_distance: candidate.editDistance ?? null,
      learn_opt_in: candidate.learnOptIn,
      synthesized_at: candidate.synthesizedAt.toISOString(),
    };

    await this.deps.outboxRepository.enqueue({
      tenantId: candidate.tenantId,
      eventType: "learning.candidate.synthesized.v1",
      idempotencyKey: candidate.dedupeKey,
      payload,
    });

    await this.deps.eventPublisher.publish(
      tenantScopedSubject(
        candidate.tenantId,
        "learning.candidate.synthesized.v1",
      ),
      payload,
    );

    return candidate;
  }

  // ── Critique-feedback path (new) ─────────────────────────────────────────

  /**
   * Processes a `critique.completed.v1` event and updates the active playbook
   * for the affected artifact kind.
   *
   * When the critique verdict is "revise" or "reject":
   *   1. Loads the current active playbook for the artifact kind.
   *   2. Appends new rubric criteria derived from the failure reasons.
   *   3. Creates a new playbook version in PlaybookVersionsRepository.
   *   4. Emits `learning.playbook.updated.v1` to outbox + NATS.
   *
   * Returns the new PlaybookVersionRecord, or null when:
   *   - No playbookRepository is configured.
   *   - Verdict is "approve" (no corrective signal).
   *   - Artifact kind has no known playbook type mapping.
   *
   * The method is idempotent per critique_id: the outbox key guards against
   * duplicate emissions if the message is redelivered.
   */
  async processFromCritique(
    tenantId: string,
    rawPayload: unknown,
  ): Promise<PlaybookVersionRecord | null> {
    if (!this.deps.playbookRepository) return null;

    const critique = critiqueCompletedPayloadSchema.parse(rawPayload);

    // Only corrective verdicts carry signal worth learning from.
    if (critique.verdict === "approve") return null;

    const playbookType = resolvePlaybookType(critique.artifact_kind);
    if (!playbookType) return null;

    const existing = await this.deps.playbookRepository.getActive(
      tenantId,
      playbookType,
    );

    const { content: updatedContent, addedCriteria } =
      buildUpdatedRubricContent(existing?.content, critique.reasons);

    const newVersion = await this.deps.playbookRepository.create(tenantId, {
      playbookType,
      name: `${playbookType} rubric — critique ${critique.critique_id.slice(0, 8)}`,
      description:
        `Auto-updated from critique verdict "${critique.verdict}". ` +
        `Added ${addedCriteria.length} criterion(s) from ${critique.reasons.length} failure reason(s).`,
      content: updatedContent as Record<string, unknown>,
      createdBy: `critique:${critique.critique_id}`,
      effectiveAt: new Date(),
    });

    const eventPayload = {
      tenant_id: tenantId,
      playbook_version_id: newVersion.id,
      playbook_type: playbookType,
      artifact_kind: critique.artifact_kind,
      artifact_id: critique.artifact_id,
      critique_id: critique.critique_id,
      verdict: critique.verdict,
      criteria_added: addedCriteria.length,
      updated_at: new Date().toISOString(),
    };

    await this.deps.outboxRepository.enqueue({
      tenantId,
      eventType: "learning.playbook.updated.v1",
      idempotencyKey: `playbook-update:${critique.critique_id}`,
      payload: eventPayload,
    });

    await this.deps.eventPublisher.publish(
      tenantScopedSubject(tenantId, "learning.playbook.updated.v1"),
      eventPayload,
    );

    return newVersion;
  }
}
