import {
  type AdaptiveLearningPolicy,
  type LearningProposalEvaluation,
  evaluateLearningProposal,
} from "@growthos/core";
import type {
  LearningProposalRecord,
  LearningProposalRepository,
  OutboxRepository,
  PlaybookVersionRecord,
  PlaybookVersionsRepository,
} from "@growthos/db";
import { z } from "zod";
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
  /** Delivery is outbox-only; retained as an optional compatibility seam. */
  eventPublisher?: EventPublisher;
  playbookRepository?: PlaybookVersionsRepository;
  /**
   * Durable lifecycle store for every proposed change. When configured, a
   * critique can never mutate a playbook until its experiment evidence and
   * policy decision have been persisted here.
   */
  learningProposalRepository?: LearningProposalRepository;
  promotionEvidenceProvider?: PromotionEvidenceProvider;
  learningPolicy?: Partial<AdaptiveLearningPolicy>;
}

export interface PlaybookChangeProposal {
  tenantId: string;
  proposalId: string;
  artifactKind: string;
  artifactId: string;
  playbookType: "blog_draft" | "content_brief" | "intel_brief" | "custom";
  verdict: "revise" | "reject";
}

/** Supplies outcome/attribution aggregates from the experiment store. */
export interface PromotionEvidenceProvider {
  getEvaluation(
    proposal: PlaybookChangeProposal,
  ): Promise<LearningProposalEvaluation | null>;
}

const persistedCritiqueProposalPayloadSchema = z.object({
  tenant_id: z.string().uuid(),
  proposal_id: z.string().min(1),
  experiment_id: z.string().uuid().optional(),
  change_risk: z.enum(["low", "medium", "high", "critical"]),
  playbook_type: z.enum([
    "blog_draft",
    "content_brief",
    "intel_brief",
    "custom",
  ]),
  artifact_kind: z.string().min(1),
  artifact_id: z.string().min(1),
  critique_id: z.string().min(1),
  source: z.string().min(1),
  prompt_version: z.string().min(1),
  verdict: z.enum(["revise", "reject"]),
  confidence_score: z.number().min(0).max(1),
  failure_reasons: z.array(z.string().min(1)),
  critiqued_at: z.string().datetime({ offset: true }),
  status: z.literal("awaiting_evidence"),
  proposed_at: z.string().datetime({ offset: true }),
});

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

  async process(input: unknown): Promise<LearningCandidate> {
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

    return candidate;
  }

  // ── Critique-feedback path (new) ─────────────────────────────────────────

  /**
   * Processes a `critique.completed.v1` event and updates the active playbook
   * for the affected artifact kind.
   *
   * When the critique verdict is "revise" or "reject":
   *   1. Loads the current active playbook for the artifact kind.
   *   2. Emits an immutable change proposal derived from the failure reasons.
   *   3. Requests aggregated evidence from the experiment/attribution store.
   *   4. Creates a new version only when the shared promotion policy passes.
   *   5. Emits `learning.playbook.updated.v1` to outbox + NATS.
   *
   * Returns the new PlaybookVersionRecord, or null when:
   *   - No playbookRepository or promotion evidence provider is configured.
   *   - Verdict is "approve" (no corrective signal).
   *   - Artifact kind has no known playbook type mapping.
   *
   * The method is idempotent per critique_id. Persisted playbook history is
   * checked before a version is created, and outbox keys dedupe emissions.
   */
  async processFromCritique(
    tenantId: string,
    rawPayload: unknown,
  ): Promise<PlaybookVersionRecord | null> {
    const critique = critiqueCompletedPayloadSchema.parse(rawPayload);

    // Only corrective verdicts carry signal worth learning from.
    if (critique.verdict === "approve") return null;

    const playbookType = resolvePlaybookType(critique.artifact_kind);
    if (!playbookType) return null;

    const proposal: PlaybookChangeProposal = {
      tenantId,
      proposalId: `critique:${critique.critique_id}`,
      artifactKind: critique.artifact_kind,
      artifactId: critique.artifact_id,
      playbookType,
      verdict: critique.verdict,
    };

    // A safe default is deliberate: the learner may not infer a lower risk
    // tier from an LLM critique. A producer that has passed policy evaluation
    // can explicitly attach a lower risk tier to the immutable critique event.
    const risk = critique.change_risk ?? "high";

    const proposedPayload = {
      tenant_id: tenantId,
      proposal_id: proposal.proposalId,
      ...(critique.experiment_id
        ? { experiment_id: critique.experiment_id }
        : {}),
      change_risk: risk,
      playbook_type: playbookType,
      artifact_kind: critique.artifact_kind,
      artifact_id: critique.artifact_id,
      critique_id: critique.critique_id,
      source: critique.source,
      prompt_version: critique.prompt_version,
      verdict: critique.verdict,
      confidence_score: critique.confidence_score,
      failure_reasons: critique.reasons,
      critiqued_at: critique.critiqued_at,
      status: "awaiting_evidence",
      proposed_at: new Date().toISOString(),
    };

    const persistedProposal = await this.persistProposal(
      tenantId,
      proposal,
      critique,
      risk,
      proposedPayload,
    );

    await this.deps.outboxRepository.enqueue({
      tenantId,
      eventType: "learning.playbook.change.proposed.v1",
      idempotencyKey: `playbook-proposal:${critique.critique_id}`,
      payload: {
        ...proposedPayload,
        ...(persistedProposal
          ? { learning_proposal_id: persistedProposal.id }
          : {}),
      },
    });
    if (!this.deps.playbookRepository || !this.deps.promotionEvidenceProvider) {
      return null;
    }

    const evaluation =
      await this.deps.promotionEvidenceProvider.getEvaluation(proposal);
    if (!evaluation) return null;

    const promotion = evaluateLearningProposal(
      evaluation,
      this.deps.learningPolicy,
    );

    const isPromotionEligible = await this.recordPromotionDecision(
      tenantId,
      persistedProposal,
      evaluation,
      promotion,
    );
    if (!isPromotionEligible) return null;
    if (promotion.decision !== "promote") return null;

    return this.promotePlaybookChange(
      tenantId,
      proposal,
      critique,
      playbookType,
      persistedProposal,
      promotion.relativeLift,
    );
  }

  /**
   * Processes the durable request emitted after a founder approves a
   * high-risk proposal. Evidence is deliberately re-read: a prior approval
   * does not license promotion if attribution or guardrails have since moved.
   */
  async processApprovedProposal(
    tenantId: string,
    proposalId: string,
  ): Promise<PlaybookVersionRecord | null> {
    if (
      !this.deps.learningProposalRepository ||
      !this.deps.playbookRepository ||
      !this.deps.promotionEvidenceProvider
    ) {
      return null;
    }

    const persistedProposal =
      await this.deps.learningProposalRepository.getById(tenantId, proposalId);
    if (!persistedProposal || persistedProposal.status !== "approved") {
      return null;
    }

    const stored = persistedCritiqueProposalPayloadSchema.parse(
      persistedProposal.proposalPayload,
    );
    const critique = critiqueCompletedPayloadSchema.parse({
      critique_id: stored.critique_id,
      source: stored.source,
      artifact_kind: stored.artifact_kind,
      artifact_id: stored.artifact_id,
      ...(stored.experiment_id ? { experiment_id: stored.experiment_id } : {}),
      change_risk: stored.change_risk,
      prompt_version: stored.prompt_version,
      verdict: stored.verdict,
      confidence_score: stored.confidence_score,
      reasons: stored.failure_reasons,
      critiqued_at: stored.critiqued_at,
    });
    const proposal: PlaybookChangeProposal = {
      tenantId,
      proposalId: stored.proposal_id,
      artifactKind: stored.artifact_kind,
      artifactId: stored.artifact_id,
      playbookType: stored.playbook_type,
      verdict: stored.verdict,
    };
    const evaluation =
      await this.deps.promotionEvidenceProvider.getEvaluation(proposal);
    if (!evaluation) return null;

    const promotion = evaluateLearningProposal(
      evaluation,
      this.deps.learningPolicy,
    );
    const isPromotionEligible = await this.recordPromotionDecision(
      tenantId,
      persistedProposal,
      evaluation,
      promotion,
    );
    if (!isPromotionEligible || promotion.decision !== "promote") return null;

    return this.promotePlaybookChange(
      tenantId,
      proposal,
      critique,
      stored.playbook_type,
      persistedProposal,
      promotion.relativeLift,
    );
  }

  private async promotePlaybookChange(
    tenantId: string,
    proposal: PlaybookChangeProposal,
    critique: CritiqueCompletedPayload,
    playbookType: PlaybookChangeProposal["playbookType"],
    persistedProposal: LearningProposalRecord | null,
    relativeLift: number,
  ): Promise<PlaybookVersionRecord | null> {
    if (!this.deps.playbookRepository) {
      throw new Error("Playbook repository is required to promote a proposal.");
    }

    // The durable proposal is the single-writer boundary. Claim it before
    // even looking for an idempotent version: a later worker can safely
    // reconcile a version left behind by a crashed claimant only after its
    // bounded lease expires. Legacy callers without a durable proposal retain
    // their compatibility path, but production learning always has one.
    const promotionClaim =
      persistedProposal && this.deps.learningProposalRepository
        ? await this.deps.learningProposalRepository.claimPromotion(
            tenantId,
            persistedProposal.id,
          )
        : null;
    if (persistedProposal && !promotionClaim) {
      return null;
    }

    const priorVersions = await this.deps.playbookRepository.listAll(
      tenantId,
      playbookType,
    );
    const createdBy = `critique:${critique.critique_id}`;
    const existingPromotion = priorVersions.find(
      (version) => version.createdBy === createdBy,
    );
    if (existingPromotion) {
      // A previous claimant may have created the version and crashed before it
      // could publish the durable update. Enqueue is idempotent, so this also
      // safely reconciles ordinary redelivery.
      await this.enqueuePlaybookUpdated(
        tenantId,
        proposal,
        critique,
        playbookType,
        persistedProposal,
        existingPromotion.id,
        0,
        relativeLift,
      );
      await this.markProposalPromoted(
        tenantId,
        persistedProposal,
        existingPromotion.id,
        promotionClaim?.token,
      );
      return existingPromotion;
    }

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
      createdBy,
      effectiveAt: new Date(),
    });

    // This must happen before the terminal state transition. If the process
    // crashes after creating the immutable version, its expiring proposal
    // lease allows a replay to find that version and durably publish this
    // idempotent event before marking the proposal promoted.
    await this.enqueuePlaybookUpdated(
      tenantId,
      proposal,
      critique,
      playbookType,
      persistedProposal,
      newVersion.id,
      addedCriteria.length,
      relativeLift,
    );
    await this.markProposalPromoted(
      tenantId,
      persistedProposal,
      newVersion.id,
      promotionClaim?.token,
    );

    return newVersion;
  }

  private async enqueuePlaybookUpdated(
    tenantId: string,
    proposal: PlaybookChangeProposal,
    critique: CritiqueCompletedPayload,
    playbookType: PlaybookChangeProposal["playbookType"],
    persistedProposal: LearningProposalRecord | null,
    playbookVersionId: string,
    criteriaAdded: number,
    relativeLift: number,
  ): Promise<void> {
    await this.deps.outboxRepository.enqueue({
      tenantId,
      eventType: "learning.playbook.updated.v1",
      idempotencyKey: `playbook-update:${critique.critique_id}`,
      payload: {
        tenant_id: tenantId,
        playbook_version_id: playbookVersionId,
        playbook_type: playbookType,
        artifact_kind: critique.artifact_kind,
        artifact_id: critique.artifact_id,
        critique_id: critique.critique_id,
        verdict: critique.verdict,
        criteria_added: criteriaAdded,
        proposal_id: proposal.proposalId,
        ...(persistedProposal
          ? { learning_proposal_id: persistedProposal.id }
          : {}),
        relative_lift: relativeLift,
        updated_at: new Date().toISOString(),
      },
    });
  }

  private async recordPromotionDecision(
    tenantId: string,
    persistedProposal: LearningProposalRecord | null,
    evaluation: LearningProposalEvaluation,
    promotion: ReturnType<typeof evaluateLearningProposal>,
  ): Promise<boolean> {
    if (!persistedProposal || !this.deps.learningProposalRepository) {
      return true;
    }

    const recorded =
      await this.deps.learningProposalRepository.recordEvaluation(
        tenantId,
        persistedProposal.id,
        {
          decision: promotion.decision,
          evidenceSnapshot: {
            evidence_count: evaluation.evidenceCount,
            unique_entities: evaluation.uniqueEntities,
            confidence: evaluation.confidence,
            baseline_metric: evaluation.baselineMetric,
            candidate_metric: evaluation.candidateMetric,
            worst_guardrail_regression: evaluation.worstGuardrailRegression,
          },
          evaluationSnapshot: {
            proposal_id: evaluation.proposalId,
            risk: evaluation.risk,
            evidence_count: evaluation.evidenceCount,
            unique_entities: evaluation.uniqueEntities,
            confidence: evaluation.confidence,
            metric_direction: evaluation.metricDirection,
            baseline_metric: evaluation.baselineMetric,
            candidate_metric: evaluation.candidateMetric,
            worst_guardrail_regression: evaluation.worstGuardrailRegression,
            human_approved: evaluation.humanApproved,
            relative_lift: promotion.relativeLift,
          },
          decisionReasons: promotion.reasons,
        },
      );

    // Another delivery may have already persisted a terminal decision. Do not
    // use a stale in-memory evaluation to create another version.
    return recorded?.status === "approved";
  }

  /**
   * Persist a proposal before anything asks for evidence. This makes a
   * missing experiment/observation an explicit `awaiting_evidence` state,
   * rather than an untraceable no-op in a worker log.
   */
  private async persistProposal(
    tenantId: string,
    proposal: PlaybookChangeProposal,
    critique: CritiqueCompletedPayload,
    risk: "low" | "medium" | "high" | "critical",
    proposedPayload: Record<string, unknown>,
  ): Promise<LearningProposalRecord | null> {
    if (!this.deps.learningProposalRepository) return null;

    return this.deps.learningProposalRepository.create(tenantId, {
      proposalKey: proposal.proposalId,
      ...(critique.experiment_id
        ? { experimentId: critique.experiment_id }
        : {}),
      targetType: proposal.playbookType,
      targetId: proposal.artifactId,
      risk,
      proposalPayload: proposedPayload,
      createdBy: `critique:${critique.critique_id}`,
    });
  }

  private async markProposalPromoted(
    tenantId: string,
    proposal: LearningProposalRecord | null,
    versionId: string,
    promotionClaimToken: string | undefined,
  ): Promise<void> {
    if (!proposal || !this.deps.learningProposalRepository) return;
    if (!promotionClaimToken) {
      throw new Error(
        `Missing promotion claim for learning proposal ${proposal.id}.`,
      );
    }
    const marked = await this.deps.learningProposalRepository.markPromoted(
      tenantId,
      proposal.id,
      versionId,
      promotionClaimToken,
    );
    if (!marked) {
      // A duplicate message can observe an already-promoted proposal only
      // when it reconciles the same immutable version. A different version is
      // a fenced-claim conflict and must remain visible for retry/escalation.
      const current = await this.deps.learningProposalRepository.getById(
        tenantId,
        proposal.id,
      );
      if (
        current?.status !== "promoted" ||
        current.promotedVersionRef !== versionId
      ) {
        throw new Error(
          `Unable to mark learning proposal ${proposal.id} as promoted.`,
        );
      }
    }
  }
}
