import { approvalFeedbackActionSchema } from "@growthos/db";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Critique-completed event payload (emitted by worker-critique)
// ---------------------------------------------------------------------------

export const critiqueVerdictSchema = z.enum(["approve", "revise", "reject"]);
export type CritiqueVerdict = z.infer<typeof critiqueVerdictSchema>;

export const critiqueCompletedPayloadSchema = z.object({
  critique_id: z.string().min(1),
  source: z.string().min(1),
  artifact_kind: z.string().min(1),
  artifact_id: z.string().min(1),
  /**
   * The experiment that produced the candidate artifact, when it was created
   * under a canary. Keeping this on the immutable critique event lets the
   * learner link a proposed playbook mutation to measured outcomes without
   * guessing from artifact names.
   */
  experiment_id: z.string().uuid().optional(),
  /**
   * Risk is declared by the producer/policy layer, never inferred from model
   * output. Absent a declaration the learner treats a proposed public-facing
   * playbook change as high risk.
   */
  change_risk: z.enum(["low", "medium", "high", "critical"]).optional(),
  prompt_version: z.string().min(1),
  verdict: critiqueVerdictSchema,
  confidence_score: z.number().min(0).max(1),
  reasons: z.array(z.string().min(1)),
  critiqued_at: z.string().datetime({ offset: true }),
});
export type CritiqueCompletedPayload = z.infer<
  typeof critiqueCompletedPayloadSchema
>;

// ---------------------------------------------------------------------------
// Rubric content schema — minimal subset needed to extend existing playbooks.
// Must remain structurally compatible with rubricPlaybookContentSchema in
// worker-critique/src/playbook-rubric.ts (same JSONB shape).
// ---------------------------------------------------------------------------

export const learnerRubricCriterionSchema = z.object({
  id: z.string().min(1),
  weight: z.number().min(0).max(1),
  description: z.string().min(1),
  check: z.string().min(1),
});
export type LearnerRubricCriterion = z.infer<
  typeof learnerRubricCriterionSchema
>;

export const learnerRubricContentSchema = z.object({
  rubric: z.array(learnerRubricCriterionSchema).min(1),
  min_word_count: z.number().int().positive().optional(),
  max_word_count: z.number().int().positive().optional(),
  forbidden_phrases: z.array(z.string().min(1)).optional(),
});
export type LearnerRubricContent = z.infer<typeof learnerRubricContentSchema>;

// ---------------------------------------------------------------------------
// Playbook-updated event payload (emitted by LearningWorker)
// ---------------------------------------------------------------------------

export const playbookUpdatedPayloadSchema = z.object({
  tenant_id: z.string().uuid(),
  playbook_version_id: z.string().uuid(),
  playbook_type: z.string().min(1),
  artifact_kind: z.string().min(1),
  artifact_id: z.string().min(1),
  critique_id: z.string().min(1),
  verdict: critiqueVerdictSchema,
  criteria_added: z.number().int().nonnegative(),
  updated_at: z.string().datetime({ offset: true }),
});
export type PlaybookUpdatedPayload = z.infer<
  typeof playbookUpdatedPayloadSchema
>;

// ---------------------------------------------------------------------------
// Approval-feedback learning signal (existing — unchanged)
// ---------------------------------------------------------------------------

export const learningSignalSchema = z.object({
  tenantId: z.string().uuid(),
  learningId: z.string().min(1),
  dedupeKey: z.string().min(1),
  source: z.string().min(1),
  issueId: z.string().uuid(),
  outputType: z.string().min(1),
  action: approvalFeedbackActionSchema,
  editDistance: z.number().min(0).max(1).nullable().optional(),
  rubricFailures: z.array(z.string().min(1)).default([]),
  reviewerNote: z.string().optional(),
  learnOptIn: z.boolean().default(true),
});

export type LearningSignal = z.infer<typeof learningSignalSchema>;

export const learningPrioritySchema = z.enum(["high", "medium", "low"]);
export const learningDispositionSchema = z.enum(["candidate", "discarded"]);

export const learningCandidateSchema = learningSignalSchema.extend({
  disposition: learningDispositionSchema,
  priority: learningPrioritySchema,
  confidenceScore: z.number().min(0).max(1),
  reasons: z.array(z.string().min(1)),
  synthesizedAt: z.date(),
});

export type LearningCandidate = z.infer<typeof learningCandidateSchema>;
