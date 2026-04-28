/**
 * CritiqueWorker — Phase 1 / S4
 *
 * Scores a candidate output and emits a `critique.completed.v1` event.
 *
 * Scoring strategy (two-tier, graceful degradation):
 *
 *   1. Playbook-driven (preferred): when `playbookRepository` is injected and
 *      an active `PlaybookVersionRecord` exists for the artifact's kind, the
 *      worker evaluates the candidate against the playbook's rubric criteria
 *      using deterministic checks (`playbook-rubric.ts`).  LLM-based checks
 *      can be swapped in per-criterion in Phase 1 S7 without touching the
 *      worker contract.
 *
 *   2. Heuristic fallback: when no playbook is available (or no repo is
 *      injected), the original length/reviewer-notes heuristic runs.  This
 *      keeps the worker useful from day 0 before any playbooks are seeded.
 *
 * Verdict thresholds (both paths):
 *   score >= 0.8  → approve
 *   score >= 0.5  → revise
 *   score <  0.5  → reject
 */

import type {
  OutboxRepository,
  PlaybookVersionsRepository,
} from "@growthos/db";
import { tenantScopedSubject } from "@growthos/db";
import {
  type CritiqueRequest,
  type CritiqueResult,
  critiqueRequestSchema,
  critiqueResultSchema,
} from "./contracts.js";
import {
  type RubricEvaluationResult,
  artifactKindToPlaybookType,
  evaluateRubric,
  rubricPlaybookContentSchema,
} from "./playbook-rubric.js";

// ---------------------------------------------------------------------------
// Verdict helpers
// ---------------------------------------------------------------------------

const verdictFromScore = (score: number): "approve" | "revise" | "reject" => {
  if (score >= 0.8) return "approve";
  if (score >= 0.5) return "revise";
  return "reject";
};

// ---------------------------------------------------------------------------
// Heuristic scorer (original — kept for backward compatibility and fallback)
// ---------------------------------------------------------------------------

export const scoreCritique = (
  input: Pick<
    CritiqueRequest,
    "candidateOutput" | "reviewerNotes" | "tenantId" | "artifactKind"
  >,
): {
  verdict: "approve" | "revise" | "reject";
  confidenceScore: number;
  reasons: string[];
} => {
  const candidateLength = input.candidateOutput.trim().length;
  const hasReviewerNotes = input.reviewerNotes.length > 0;

  if (candidateLength < 120 || hasReviewerNotes) {
    return {
      verdict: "revise",
      confidenceScore: 0.52,
      reasons: ["Output needs stronger evidence and tighter structure."],
    };
  }

  if (candidateLength > 1200) {
    return {
      verdict: "reject",
      confidenceScore: 0.34,
      reasons: ["Output is too long for the current distribution channel."],
    };
  }

  return {
    verdict: "approve",
    confidenceScore: 0.86,
    reasons: ["Output passes structural quality checks."],
  };
};

// ---------------------------------------------------------------------------
// Playbook scorer
// ---------------------------------------------------------------------------

const scoreWithRubric = (
  rubricResult: RubricEvaluationResult,
): {
  verdict: "approve" | "revise" | "reject";
  confidenceScore: number;
  reasons: string[];
} => ({
  verdict: verdictFromScore(rubricResult.score),
  // Confidence is the rubric score itself — represents fraction of criteria met.
  confidenceScore: rubricResult.score,
  reasons: rubricResult.reasons,
});

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export interface EventPublisher {
  publish(subject: string, payload: Record<string, unknown>): Promise<void>;
}

export interface CritiqueWorkerDependencies {
  outboxRepository: OutboxRepository;
  eventPublisher: EventPublisher;
  /**
   * Optional: when provided, the worker loads an active playbook for the
   * artifact kind and uses rubric-driven scoring.  Falls back to heuristic
   * when no matching playbook is found or when this is omitted.
   */
  playbookRepository?: PlaybookVersionsRepository;
}

export class CritiqueWorker {
  constructor(private readonly deps: CritiqueWorkerDependencies) {}

  async critique(input: CritiqueRequest): Promise<CritiqueResult> {
    const request = critiqueRequestSchema.parse(input);

    // Attempt playbook-driven scoring first.
    const playbookScore = await this.scoreWithPlaybook(request);
    const scoring = playbookScore ?? scoreCritique(request);

    const result = critiqueResultSchema.parse({
      ...request,
      ...scoring,
      critiquedAt: new Date(),
    });

    const payload = {
      critique_id: result.critiqueId,
      source: result.source,
      artifact_kind: result.artifactKind,
      artifact_id: result.artifactId,
      prompt_version: result.promptVersion,
      verdict: result.verdict,
      confidence_score: result.confidenceScore,
      reasons: result.reasons,
      critiqued_at: result.critiquedAt.toISOString(),
    };

    await this.deps.outboxRepository.enqueue({
      tenantId: result.tenantId,
      eventType: "critique.completed.v1",
      idempotencyKey: result.dedupeKey,
      payload,
    });

    await this.deps.eventPublisher.publish(
      tenantScopedSubject(result.tenantId, "critique.completed.v1"),
      payload,
    );

    return result;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async scoreWithPlaybook(request: CritiqueRequest): Promise<{
    verdict: "approve" | "revise" | "reject";
    confidenceScore: number;
    reasons: string[];
  } | null> {
    if (!this.deps.playbookRepository) return null;

    const playbookType = artifactKindToPlaybookType(request.artifactKind);
    if (!playbookType) return null;

    const playbook = await this.deps.playbookRepository.getActive(
      request.tenantId,
      playbookType,
    );
    if (!playbook) return null;

    // Validate playbook content shape before using it.
    const parsed = rubricPlaybookContentSchema.safeParse(playbook.content);
    if (!parsed.success) return null;

    const rubricResult = evaluateRubric(parsed.data, request.candidateOutput);
    return scoreWithRubric(rubricResult);
  }
}
