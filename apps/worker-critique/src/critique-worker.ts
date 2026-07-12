/**
 * CritiqueWorker — Phase 1 / S4
 *
 * Scores a candidate output and emits a `critique.completed.v1` event.
 *
 * Scoring strategy (three-tier, graceful degradation):
 *
 *   1. LLM-driven (preferred): when `llmCallRunner` is injected, the worker
 *      calls `CRITIQUE_EVALUATE_PROMPT` for a structured verdict+reasons JSON.
 *      Falls through to tier 2 on any runner error or invalid JSON.
 *
 *   2. Playbook-driven: when `playbookRepository` is injected and an active
 *      `PlaybookVersionRecord` exists for the artifact kind, rubric criteria
 *      are evaluated deterministically (`playbook-rubric.ts`).
 *
 *   3. Heuristic fallback: length/reviewer-notes heuristic.  Always available
 *      from day 0 before any playbook or LLM is configured.
 *
 * Verdict thresholds (all paths):
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
  CRITIQUE_EVALUATE_PROMPT,
  type LlmCallRunner,
} from "@growthos/llm-harness";
import {
  type CritiqueRequest,
  type CritiqueResult,
  critiqueRequestSchema,
  critiqueResultSchema,
} from "./contracts.js";
import {
  type RubricEvaluationResult,
  artifactKindToPlaybookType,
  evaluateRubricAsync,
  rubricPlaybookContentSchema,
} from "./playbook-rubric.js";

// ---------------------------------------------------------------------------
// Verdict thresholds — overridable via env for per-deployment tuning
// ---------------------------------------------------------------------------

export const CRITIQUE_APPROVE_THRESHOLD = (() => {
  const v = Number(process.env.CRITIQUE_APPROVE_THRESHOLD);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.8;
})();

export const CRITIQUE_REVISE_THRESHOLD = (() => {
  const v = Number(process.env.CRITIQUE_REVISE_THRESHOLD);
  return Number.isFinite(v) && v > 0 && v < CRITIQUE_APPROVE_THRESHOLD
    ? v
    : 0.5;
})();

const verdictFromScore = (score: number): "approve" | "revise" | "reject" => {
  if (score >= CRITIQUE_APPROVE_THRESHOLD) return "approve";
  if (score >= CRITIQUE_REVISE_THRESHOLD) return "revise";
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
   * Optional: when provided the worker calls CRITIQUE_EVALUATE_PROMPT for
   * an LLM-driven verdict.  Falls back to playbook or heuristic on failure.
   */
  llmCallRunner?: LlmCallRunner;
  /**
   * Optional: when provided, the worker loads an active playbook for the
   * artifact kind and uses rubric-driven scoring.  Falls back to heuristic
   * when no matching playbook is found or when this is omitted.
   */
  playbookRepository?: PlaybookVersionsRepository;
}

// ---------------------------------------------------------------------------
// LLM response schema
// ---------------------------------------------------------------------------

import { z } from "zod";

const llmCritiqueResponseSchema = z
  .object({
    verdict: z.enum(["approve", "revise", "reject"]),
    confidence_score: z.number().min(0).max(1).optional(),
    confidenceScore: z.number().min(0).max(1).optional(),
    reasons: z.array(z.string()).min(1),
  })
  .transform((v) => ({
    verdict: v.verdict,
    confidenceScore: v.confidenceScore ?? v.confidence_score ?? 0.7,
    reasons: v.reasons,
  }));

// ---------------------------------------------------------------------------
// Public helper: LLM critique scorer (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Calls the LLM with CRITIQUE_EVALUATE_PROMPT and parses the structured JSON
 * response.  Returns null when the runner throws, the response contains no
 * JSON, or the parsed object fails schema validation.
 */
export const critiqueWithLlm = async (
  request: Pick<
    CritiqueRequest,
    "tenantId" | "artifactKind" | "candidateOutput" | "reviewerNotes"
  >,
  runner: LlmCallRunner,
): Promise<{
  verdict: "approve" | "revise" | "reject";
  confidenceScore: number;
  reasons: string[];
} | null> => {
  let content: string;
  try {
    const rubricHint =
      request.reviewerNotes.length > 0
        ? `Reviewer notes: ${request.reviewerNotes.join("; ")}`
        : "No reviewer notes provided.";

    const result = await runner.run(
      CRITIQUE_EVALUATE_PROMPT,
      {
        artifactKind: request.artifactKind,
        candidateOutput: request.candidateOutput,
        rubricCriteria: rubricHint,
      },
      {
        tenantId: request.tenantId,
        agentId: "critique-worker",
        responseFormat: { type: "json_object" },
      },
    );
    content = result.content;
  } catch {
    return null;
  }

  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    const parsed = llmCritiqueResponseSchema.safeParse(JSON.parse(match[0]));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

export class CritiqueWorker {
  constructor(private readonly deps: CritiqueWorkerDependencies) {}

  async critique(input: CritiqueRequest): Promise<CritiqueResult> {
    const request = critiqueRequestSchema.parse(input);

    // Three-tier scoring: LLM → playbook rubric → heuristic.
    const llmScore = this.deps.llmCallRunner
      ? await critiqueWithLlm(request, this.deps.llmCallRunner)
      : null;
    const playbookScore = llmScore
      ? null
      : await this.scoreWithPlaybook(request);
    const scoring = llmScore ?? playbookScore ?? scoreCritique(request);

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

    // Pass the LLM runner through so custom rubric criteria can be evaluated
    // by the model rather than auto-passing.  Known checks remain deterministic.
    const rubricResult = await evaluateRubricAsync(
      parsed.data,
      request.candidateOutput,
      this.deps.llmCallRunner,
    );
    return scoreWithRubric(rubricResult);
  }
}
