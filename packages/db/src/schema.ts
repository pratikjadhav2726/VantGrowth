import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// All GrowthOS tables live under the `growthos` Postgres schema so they are
// co-located without polluting the `public` schema.
const growthos = pgSchema("growthos");

// ─── motion_scores ──────────────────────────────────────────────────────────

export const motionScores = growthos.table(
  "motion_scores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    scoredAt: timestamp("scored_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    scorerVersion: text("scorer_version").notNull(),
    scores: jsonb("scores").notNull().$type<Record<string, number>>(),
    inputsDigest: text("inputs_digest").notNull(),
    rationale: text("rationale").array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("motion_scores_tenant_scored_at_idx").on(
      table.tenantId,
      table.scoredAt.desc(),
    ),
  ],
);

export type MotionScore = typeof motionScores.$inferSelect;
export type NewMotionScore = typeof motionScores.$inferInsert;

// ─── motion_stack ────────────────────────────────────────────────────────────

export const motionStack = growthos.table(
  "motion_stack",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    primaryMotions: text("primary_motions").array().notNull(),
    secondaryMotions: text("secondary_motions").array().notNull(),
    observeOnly: text("observe_only")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    deactivated: text("deactivated")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    sourceScoreId: uuid("source_score_id").references(() => motionScores.id),
    approvedBy: uuid("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    version: numeric("version").notNull().default("1"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("motion_stack_tenant_version_idx").on(
      table.tenantId,
      table.version.desc(),
    ),
    unique("motion_stack_tenant_version_unique").on(
      table.tenantId,
      table.version,
    ),
  ],
);

export type MotionStack = typeof motionStack.$inferSelect;
export type NewMotionStack = typeof motionStack.$inferInsert;

// ─── approval_feedback ───────────────────────────────────────────────────────

export const approvalFeedback = growthos.table(
  "approval_feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    outputType: text("output_type").notNull(),
    action: text("action")
      .notNull()
      .$type<
        "approved" | "edited_then_approved" | "rejected" | "auto_approved"
      >(),
    editDistance: numeric("edit_distance", { precision: 6, scale: 4 }),
    rubricFailures: text("rubric_failures")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    reviewerNote: text("reviewer_note"),
    learnOptIn: boolean("learn_opt_in").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("approval_feedback_tenant_output_created_idx").on(
      table.tenantId,
      table.outputType,
      table.createdAt.desc(),
    ),
    check(
      "approval_feedback_action_check",
      sql`${table.action} IN ('approved', 'edited_then_approved', 'rejected', 'auto_approved')`,
    ),
  ],
);

export type ApprovalFeedback = typeof approvalFeedback.$inferSelect;
export type NewApprovalFeedback = typeof approvalFeedback.$inferInsert;

// ─── event_outbox ─────────────────────────────────────────────────────────────

export const eventOutbox = growthos.table(
  "event_outbox",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    eventType: text("event_type").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payload: jsonb("payload").notNull().$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [
    index("event_outbox_unconsumed_idx").on(
      table.tenantId,
      table.consumedAt,
      table.id,
    ),
    unique("event_outbox_idempotency_unique").on(
      table.tenantId,
      table.eventType,
      table.idempotencyKey,
    ),
  ],
);

export type EventOutboxRow = typeof eventOutbox.$inferSelect;
export type NewEventOutboxRow = typeof eventOutbox.$inferInsert;

// ─── workflow_runs ────────────────────────────────────────────────────────────

export const workflowRunStateValues = [
  "requested",
  "in_progress",
  "completed",
  "failed",
] as const;

export type WorkflowRunStateValue = (typeof workflowRunStateValues)[number];

export const workflowRuns = growthos.table(
  "workflow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    workflowId: text("workflow_id").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    state: text("state")
      .notNull()
      .default("requested")
      .$type<WorkflowRunStateValue>(),
    failureCode: text("failure_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("workflow_runs_tenant_workflow_unique").on(
      table.tenantId,
      table.workflowId,
    ),
    index("workflow_runs_tenant_state_updated_idx").on(
      table.tenantId,
      table.state,
      table.updatedAt.desc(),
    ),
    check(
      "workflow_runs_state_check",
      sql`${table.state} IN ('requested', 'in_progress', 'completed', 'failed')`,
    ),
  ],
);

export type WorkflowRunRow = typeof workflowRuns.$inferSelect;
export type NewWorkflowRunRow = typeof workflowRuns.$inferInsert;

// ─── playbook_versions ────────────────────────────────────────────────────────
//
// Stores versioned playbooks used by the Critique/Learning loop (Phase 1 S4/S5).
// Each playbook is a JSON rubric that the Critique agent compares against a
// generated artefact (blog_draft, intel_brief, etc.).  Retiring a version
// (setting retired_at) deactivates it without deleting history.

export const playbookTypeValues = [
  "content_brief",
  "intel_brief",
  "blog_draft",
  "custom",
] as const;
export type PlaybookTypeValue = (typeof playbookTypeValues)[number];

export const playbookVersions = growthos.table(
  "playbook_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    playbookType: text("playbook_type").notNull().$type<PlaybookTypeValue>(),
    version: numeric("version", { precision: 10, scale: 0 }).notNull(),
    name: text("name").notNull(),
    description: text("description"),
    content: jsonb("content").notNull().$type<Record<string, unknown>>(),
    effectiveAt: timestamp("effective_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("playbook_versions_tenant_type_version_unique").on(
      table.tenantId,
      table.playbookType,
      table.version,
    ),
    index("playbook_versions_tenant_type_retired_idx").on(
      table.tenantId,
      table.playbookType,
      table.retiredAt,
    ),
    check(
      "playbook_versions_type_check",
      sql`${table.playbookType} IN ('content_brief', 'intel_brief', 'blog_draft', 'custom')`,
    ),
  ],
);

export type PlaybookVersion = typeof playbookVersions.$inferSelect;
export type NewPlaybookVersion = typeof playbookVersions.$inferInsert;

// ─── signal_events ────────────────────────────────────────────────────────────
//
// High-volume write path: the Signal Router writes all inbound signals here.
// The Intel Director reads and processes them.  externalId is used for
// deduplication against the source system; a partial unique index prevents
// duplicates while allowing rows without an externalId.

export const signalTypeValues = [
  "competitive",
  "community",
  "icp",
  "product",
  "market",
  "internal",
] as const;
export type SignalTypeValue = (typeof signalTypeValues)[number];

export const signalEvents = growthos.table(
  "signal_events",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    signalType: text("signal_type").notNull().$type<SignalTypeValue>(),
    source: text("source").notNull(),
    externalId: text("external_id"),
    payload: jsonb("payload").notNull().$type<Record<string, unknown>>(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    /** A leased claim prevents multiple router replicas from running the same signal. */
    processingLeaseOwner: text("processing_lease_owner"),
    processingLeaseExpiresAt: timestamp("processing_lease_expires_at", {
      withTimezone: true,
    }),
    processingAttempts: integer("processing_attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("signal_events_tenant_type_created_idx").on(
      table.tenantId,
      table.signalType,
      table.createdAt.desc(),
    ),
    index("signal_events_tenant_unprocessed_idx")
      .on(table.tenantId, table.id)
      .where(sql`${table.processedAt} IS NULL`),
    index("signal_events_tenant_claimable_idx")
      .on(
        table.tenantId,
        table.signalType,
        table.processingLeaseExpiresAt,
        table.id,
      )
      .where(sql`${table.processedAt} IS NULL`),
    // Deduplicate by (tenant, source, externalId) when externalId is present.
    uniqueIndex("signal_events_tenant_source_external_uniq")
      .on(table.tenantId, table.source, table.externalId)
      .where(sql`${table.externalId} IS NOT NULL`),
    check(
      "signal_events_type_check",
      sql`${table.signalType} IN ('competitive', 'community', 'icp', 'product', 'market', 'internal')`,
    ),
  ],
);

export type SignalEvent = typeof signalEvents.$inferSelect;
export type NewSignalEvent = typeof signalEvents.$inferInsert;

// ─── tenant_settings ────────────────────────────────────────────────────────
//
// One JSON document per tenant (founder console: keys, digest email, onboarding
// profile, policy toggles). Replaces cookie-only storage when the API persists
// here; RLS isolates rows by tenant_id.

export const tenantSettings = growthos.table("tenant_settings", {
  tenantId: uuid("tenant_id").primaryKey(),
  settings: jsonb("settings")
    .notNull()
    .default(sql`'{}'::jsonb`)
    .$type<Record<string, unknown>>(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type TenantSettingsRow = typeof tenantSettings.$inferSelect;
export type NewTenantSettingsRow = typeof tenantSettings.$inferInsert;

// ─── Adaptive GTM control plane ────────────────────────────────────────────
//
// These tables make the adaptive harness durable and auditable. They are kept
// separate from the high-volume data plane: experiments describe a bounded
// decision, assignments make treatment exposure sticky, observations are
// append-only evidence, and proposals retain the gated promotion lifecycle.
// Every child relation includes tenant_id in its foreign key so a row can never
// be attached to another tenant's experiment even if an identifier leaks.

export const experimentStatusValues = [
  "draft",
  "running",
  "paused",
  "concluded",
  "abandoned",
  "promoted",
  "rolled_back",
] as const;
export type ExperimentStatusValue = (typeof experimentStatusValues)[number];

export const experimentWinnerValues = ["a", "b", "inconclusive"] as const;
export type ExperimentWinnerValue = (typeof experimentWinnerValues)[number];

export const metricDirectionValues = ["increase", "decrease"] as const;
export type MetricDirectionValue = (typeof metricDirectionValues)[number];

export const experimentVariantValues = ["a", "b"] as const;
export type ExperimentVariantValue = (typeof experimentVariantValues)[number];

export const experiments = growthos.table(
  "experiments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    /** Caller-provided, tenant-scoped key used to make experiment creation idempotent. */
    experimentKey: text("experiment_key").notNull(),
    motion: text("motion").notNull(),
    experimentType: text("experiment_type").notNull(),
    unitType: text("unit_type").notNull(),
    hypothesis: text("hypothesis").notNull(),
    variantA: jsonb("variant_a").notNull().$type<Record<string, unknown>>(),
    variantB: jsonb("variant_b").notNull().$type<Record<string, unknown>>(),
    metricName: text("metric_name").notNull(),
    metricDirection: text("metric_direction")
      .notNull()
      .default("increase")
      .$type<MetricDirectionValue>(),
    minSampleSize: integer("min_sample_size").notNull(),
    status: text("status")
      .notNull()
      .default("draft")
      .$type<ExperimentStatusValue>(),
    winner: text("winner").$type<ExperimentWinnerValue>(),
    confidence: numeric("confidence", { precision: 5, scale: 4 }),
    // Immutable context captured at decision time. It gives a replay enough
    // provenance without putting sensitive source payloads on public APIs.
    inputSnapshot: jsonb("input_snapshot")
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, unknown>>(),
    modelVersion: text("model_version"),
    promptVersion: text("prompt_version"),
    playbookVersion: text("playbook_version"),
    policyVersion: text("policy_version"),
    createdBy: text("created_by").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("experiments_tenant_experiment_key_unique").on(
      table.tenantId,
      table.experimentKey,
    ),
    // Required by tenant-safe composite foreign keys from child tables.
    unique("experiments_tenant_id_id_unique").on(table.tenantId, table.id),
    index("experiments_tenant_status_updated_idx").on(
      table.tenantId,
      table.status,
      table.updatedAt.desc(),
    ),
    index("experiments_tenant_motion_created_idx").on(
      table.tenantId,
      table.motion,
      table.createdAt.desc(),
    ),
    check(
      "experiments_status_check",
      sql`${table.status} IN ('draft', 'running', 'paused', 'concluded', 'abandoned', 'promoted', 'rolled_back')`,
    ),
    check(
      "experiments_winner_check",
      sql`${table.winner} IS NULL OR ${table.winner} IN ('a', 'b', 'inconclusive')`,
    ),
    check(
      "experiments_metric_direction_check",
      sql`${table.metricDirection} IN ('increase', 'decrease')`,
    ),
    check("experiments_min_sample_size_check", sql`${table.minSampleSize} > 0`),
    check(
      "experiments_confidence_check",
      sql`${table.confidence} IS NULL OR (${table.confidence} >= 0 AND ${table.confidence} <= 1)`,
    ),
  ],
);

export type Experiment = typeof experiments.$inferSelect;
export type NewExperiment = typeof experiments.$inferInsert;

// ─── experiment_assignments ────────────────────────────────────────────────
//
// Assignment is sticky for an independently identifiable unit. Repeated
// delivery of the same assignment key returns the original treatment instead
// of re-randomising a customer or account.

export const experimentAssignments = growthos.table(
  "experiment_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    experimentId: uuid("experiment_id").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    variant: text("variant").notNull().$type<ExperimentVariantValue>(),
    assignmentContext: jsonb("assignment_context")
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, unknown>>(),
    assignedAt: timestamp("assigned_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    exposedAt: timestamp("exposed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.experimentId],
      foreignColumns: [experiments.tenantId, experiments.id],
      name: "experiment_assignments_tenant_experiment_fk",
    }).onDelete("cascade"),
    unique("experiment_assignments_tenant_experiment_entity_unique").on(
      table.tenantId,
      table.experimentId,
      table.entityType,
      table.entityId,
    ),
    // Required by the tenant-safe observation relation below.
    unique("experiment_assignments_tenant_id_id_unique").on(
      table.tenantId,
      table.id,
    ),
    index("experiment_assignments_tenant_experiment_variant_idx").on(
      table.tenantId,
      table.experimentId,
      table.variant,
    ),
    index("experiment_assignments_tenant_entity_idx").on(
      table.tenantId,
      table.entityType,
      table.entityId,
    ),
    check(
      "experiment_assignments_variant_check",
      sql`${table.variant} IN ('a', 'b')`,
    ),
  ],
);

export type ExperimentAssignment = typeof experimentAssignments.$inferSelect;
export type NewExperimentAssignment = typeof experimentAssignments.$inferInsert;

// ─── experiment_observations ───────────────────────────────────────────────
//
// Observations are immutable evidence events. Attribution confidence is kept
// alongside the recorded outcome so a weakly attributed event cannot silently
// become strong policy evidence later.

export const experimentObservations = growthos.table(
  "experiment_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    experimentId: uuid("experiment_id").notNull(),
    assignmentId: uuid("assignment_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    variant: text("variant").notNull().$type<ExperimentVariantValue>(),
    metricName: text("metric_name").notNull(),
    metricValue: numeric("metric_value", { precision: 20, scale: 6 }).notNull(),
    isGuardrail: boolean("is_guardrail").notNull().default(false),
    attributionConfidence: numeric("attribution_confidence", {
      precision: 5,
      scale: 4,
    }).notNull(),
    attributionModel: text("attribution_model").notNull(),
    source: text("source").notNull(),
    costAmount: numeric("cost_amount", { precision: 20, scale: 6 }),
    costCurrency: text("cost_currency"),
    observedOutcome: jsonb("observed_outcome")
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, unknown>>(),
    evidence: jsonb("evidence")
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, unknown>>(),
    observedAt: timestamp("observed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.experimentId],
      foreignColumns: [experiments.tenantId, experiments.id],
      name: "experiment_observations_tenant_experiment_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.assignmentId],
      foreignColumns: [
        experimentAssignments.tenantId,
        experimentAssignments.id,
      ],
      name: "experiment_observations_tenant_assignment_fk",
    }).onDelete("cascade"),
    unique("experiment_observations_tenant_experiment_idempotency_unique").on(
      table.tenantId,
      table.experimentId,
      table.idempotencyKey,
    ),
    index("experiment_observations_tenant_experiment_metric_observed_idx").on(
      table.tenantId,
      table.experimentId,
      table.metricName,
      table.observedAt.desc(),
    ),
    index("experiment_observations_tenant_experiment_variant_idx").on(
      table.tenantId,
      table.experimentId,
      table.variant,
    ),
    check(
      "experiment_observations_variant_check",
      sql`${table.variant} IN ('a', 'b')`,
    ),
    check(
      "experiment_observations_attribution_confidence_check",
      sql`${table.attributionConfidence} >= 0 AND ${table.attributionConfidence} <= 1`,
    ),
    check(
      "experiment_observations_cost_check",
      sql`${table.costAmount} IS NULL OR ${table.costAmount} >= 0`,
    ),
    check(
      "experiment_observations_currency_check",
      sql`${table.costCurrency} IS NULL OR char_length(${table.costCurrency}) = 3`,
    ),
  ],
);

export type ExperimentObservation = typeof experimentObservations.$inferSelect;
export type NewExperimentObservation =
  typeof experimentObservations.$inferInsert;

// ─── learning_proposals ────────────────────────────────────────────────────
//
// Raw model output is stored as a proposed change, never applied in place. A
// separate evaluation and explicit promotion/rollback transition preserve the
// evidence gate required by the adaptive harness.

export const learningProposalStatusValues = [
  "awaiting_evidence",
  "evaluating",
  "requires_approval",
  "approved",
  "rejected",
  "promoted",
  "rolled_back",
] as const;
export type LearningProposalStatusValue =
  (typeof learningProposalStatusValues)[number];

export const changeRiskValues = ["low", "medium", "high", "critical"] as const;
export type ChangeRiskValue = (typeof changeRiskValues)[number];

export const learningDecisionValues = [
  "continue_experiment",
  "reject",
  "requires_approval",
  "promote",
] as const;
export type LearningDecisionValue = (typeof learningDecisionValues)[number];

export const learningProposals = growthos.table(
  "learning_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    proposalKey: text("proposal_key").notNull(),
    experimentId: uuid("experiment_id"),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    risk: text("risk").notNull().$type<ChangeRiskValue>(),
    status: text("status")
      .notNull()
      .default("awaiting_evidence")
      .$type<LearningProposalStatusValue>(),
    proposalPayload: jsonb("proposal_payload")
      .notNull()
      .$type<Record<string, unknown>>(),
    evidenceSnapshot: jsonb("evidence_snapshot")
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, unknown>>(),
    evaluationSnapshot: jsonb("evaluation_snapshot")
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, unknown>>(),
    decision: text("decision").$type<LearningDecisionValue>(),
    decisionReasons: text("decision_reasons")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    baseVersionRef: text("base_version_ref"),
    candidateVersionRef: text("candidate_version_ref"),
    promotedVersionRef: text("promoted_version_ref"),
    rollbackVersionRef: text("rollback_version_ref"),
    humanApprovedBy: text("human_approved_by"),
    humanApprovedAt: timestamp("human_approved_at", { withTimezone: true }),
    /**
     * Short-lived fencing lease held by the one worker allowed to create the
     * immutable playbook version for an approved proposal. The token is never
     * returned to founder-facing APIs.
     */
    promotionClaimToken: text("promotion_claim_token"),
    promotionClaimExpiresAt: timestamp("promotion_claim_expires_at", {
      withTimezone: true,
    }),
    createdBy: text("created_by").notNull(),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }),
    promotedAt: timestamp("promoted_at", { withTimezone: true }),
    rolledBackAt: timestamp("rolled_back_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.experimentId],
      foreignColumns: [experiments.tenantId, experiments.id],
      name: "learning_proposals_tenant_experiment_fk",
    }),
    unique("learning_proposals_tenant_proposal_key_unique").on(
      table.tenantId,
      table.proposalKey,
    ),
    index("learning_proposals_tenant_status_updated_idx").on(
      table.tenantId,
      table.status,
      table.updatedAt.desc(),
    ),
    index("learning_proposals_tenant_experiment_idx").on(
      table.tenantId,
      table.experimentId,
    ),
    index("learning_proposals_tenant_claimable_idx")
      .on(table.tenantId, table.status, table.promotionClaimExpiresAt, table.id)
      .where(sql`${table.status} = 'approved'`),
    check(
      "learning_proposals_status_check",
      sql`${table.status} IN ('awaiting_evidence', 'evaluating', 'requires_approval', 'approved', 'rejected', 'promoted', 'rolled_back')`,
    ),
    check(
      "learning_proposals_risk_check",
      sql`${table.risk} IN ('low', 'medium', 'high', 'critical')`,
    ),
    check(
      "learning_proposals_decision_check",
      sql`${table.decision} IS NULL OR ${table.decision} IN ('continue_experiment', 'reject', 'requires_approval', 'promote')`,
    ),
  ],
);

export type LearningProposal = typeof learningProposals.$inferSelect;
export type NewLearningProposal = typeof learningProposals.$inferInsert;

// ─── component_health ──────────────────────────────────────────────────────
//
// This is an append-only health decision log, not a mutable status flag. That
// preserves bounded recovery attempts and the exact rationale that disabled an
// external action, while `listLatest` can efficiently materialise the current
// state per component.

export const runtimeHealthStateValues = [
  "healthy",
  "degraded",
  "recovering",
  "quarantined",
] as const;
export type RuntimeHealthStateValue = (typeof runtimeHealthStateValues)[number];

export const healingActionValues = [
  "none",
  "resume",
  "retry_with_backoff",
  "use_fallback",
  "rollback",
  "quarantine_and_escalate",
] as const;
export type HealingActionValue = (typeof healingActionValues)[number];

export const componentHealth = growthos.table(
  "component_health",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    componentId: text("component_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    state: text("state").notNull().$type<RuntimeHealthStateValue>(),
    errorRate: numeric("error_rate", { precision: 5, scale: 4 }).notNull(),
    consecutiveFailures: integer("consecutive_failures").notNull(),
    p95LatencyMs: integer("p95_latency_ms").notNull(),
    stalenessSeconds: integer("staleness_seconds").notNull(),
    dependencyAvailable: boolean("dependency_available").notNull(),
    fallbackAvailable: boolean("fallback_available").notNull(),
    lastKnownGoodAvailable: boolean("last_known_good_available").notNull(),
    lastKnownGoodVersionRef: text("last_known_good_version_ref"),
    recoveryAttempts: integer("recovery_attempts").notNull(),
    guardrailBreached: boolean("guardrail_breached").notNull().default(false),
    action: text("action").notNull().$type<HealingActionValue>(),
    allowExternalActions: boolean("allow_external_actions").notNull(),
    retryAfterSeconds: integer("retry_after_seconds"),
    reasons: text("reasons").array().notNull().default(sql`'{}'::text[]`),
    observedAt: timestamp("observed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("component_health_tenant_component_idempotency_unique").on(
      table.tenantId,
      table.componentId,
      table.idempotencyKey,
    ),
    index("component_health_tenant_component_observed_idx").on(
      table.tenantId,
      table.componentId,
      table.observedAt.desc(),
    ),
    index("component_health_tenant_state_observed_idx").on(
      table.tenantId,
      table.state,
      table.observedAt.desc(),
    ),
    check(
      "component_health_state_check",
      sql`${table.state} IN ('healthy', 'degraded', 'recovering', 'quarantined')`,
    ),
    check(
      "component_health_action_check",
      sql`${table.action} IN ('none', 'resume', 'retry_with_backoff', 'use_fallback', 'rollback', 'quarantine_and_escalate')`,
    ),
    check(
      "component_health_error_rate_check",
      sql`${table.errorRate} >= 0 AND ${table.errorRate} <= 1`,
    ),
    check(
      "component_health_nonnegative_values_check",
      sql`${table.consecutiveFailures} >= 0 AND ${table.p95LatencyMs} >= 0 AND ${table.stalenessSeconds} >= 0 AND ${table.recoveryAttempts} >= 0`,
    ),
    check(
      "component_health_retry_after_check",
      sql`${table.retryAfterSeconds} IS NULL OR ${table.retryAfterSeconds} > 0`,
    ),
  ],
);

export type ComponentHealth = typeof componentHealth.$inferSelect;
export type NewComponentHealth = typeof componentHealth.$inferInsert;

// ─── incidents ─────────────────────────────────────────────────────────────
//
// Incidents are durable control-plane records with a sanitized title/summary
// for founder-facing read models. Diagnostic metadata remains tenant-private
// and must never be returned by a generic API serializer.

export const incidentSeverityValues = [
  "low",
  "medium",
  "high",
  "critical",
] as const;
export type IncidentSeverityValue = (typeof incidentSeverityValues)[number];

export const incidentStatusValues = [
  "open",
  "acknowledged",
  "mitigated",
  "resolved",
] as const;
export type IncidentStatusValue = (typeof incidentStatusValues)[number];

export const incidents = growthos.table(
  "incidents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    incidentKey: text("incident_key").notNull(),
    componentId: text("component_id").notNull(),
    severity: text("severity").notNull().$type<IncidentSeverityValue>(),
    status: text("status")
      .notNull()
      .default("open")
      .$type<IncidentStatusValue>(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    action: text("action").$type<HealingActionValue>(),
    rollbackVersionRef: text("rollback_version_ref"),
    diagnosticMetadata: jsonb("diagnostic_metadata")
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, unknown>>(),
    openedAt: timestamp("opened_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("incidents_tenant_incident_key_unique").on(
      table.tenantId,
      table.incidentKey,
    ),
    index("incidents_tenant_status_opened_idx").on(
      table.tenantId,
      table.status,
      table.openedAt.desc(),
    ),
    index("incidents_tenant_component_opened_idx").on(
      table.tenantId,
      table.componentId,
      table.openedAt.desc(),
    ),
    check(
      "incidents_severity_check",
      sql`${table.severity} IN ('low', 'medium', 'high', 'critical')`,
    ),
    check(
      "incidents_status_check",
      sql`${table.status} IN ('open', 'acknowledged', 'mitigated', 'resolved')`,
    ),
    check(
      "incidents_action_check",
      sql`${table.action} IS NULL OR ${table.action} IN ('none', 'resume', 'retry_with_backoff', 'use_fallback', 'rollback', 'quarantine_and_escalate')`,
    ),
  ],
);

export type Incident = typeof incidents.$inferSelect;
export type NewIncident = typeof incidents.$inferInsert;

// ─── external_actions ─────────────────────────────────────────────────────
//
// The external action ledger is the durable boundary between a founder-approved
// GrowthOS action and the n8n connector fabric.  `event_outbox` guarantees the
// request is delivered to the dispatcher; this table retains the current
// lifecycle state, retry lease, provider receipt, and eventual outcome.  The
// append-only `external_action_events` table below preserves the audit history
// needed to explain every externally-visible action.

export const externalActionStateValues = [
  "requested",
  "dispatching",
  "retry_scheduled",
  "dispatched",
  "completed",
  "failed",
] as const;
export type ExternalActionStateValue =
  (typeof externalActionStateValues)[number];

export const externalActions = growthos.table(
  "external_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    /** Stable caller-provided action identifier, unique within a tenant. */
    actionId: text("action_id").notNull(),
    /** Stable replay key used by GrowthOS and n8n. */
    idempotencyKey: text("idempotency_key").notNull(),
    /** SHA-256 digest of the canonical request; detects unsafe replay drift. */
    requestDigest: text("request_digest").notNull(),
    actionType: text("action_type").notNull(),
    approvedBy: text("approved_by").notNull(),
    requestPayload: jsonb("request_payload")
      .notNull()
      .$type<Record<string, unknown>>(),
    state: text("state")
      .notNull()
      .default("requested")
      .$type<ExternalActionStateValue>(),
    dispatchAttempts: integer("dispatch_attempts").notNull().default(0),
    dispatchLeaseOwner: text("dispatch_lease_owner"),
    dispatchLeaseExpiresAt: timestamp("dispatch_lease_expires_at", {
      withTimezone: true,
    }),
    lastDispatchAt: timestamp("last_dispatch_at", { withTimezone: true }),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    dispatchReceipt: jsonb("dispatch_receipt")
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, unknown>>(),
    outcome: jsonb("outcome")
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, unknown>>(),
    workflowId: text("workflow_id"),
    executionId: text("execution_id"),
    providerReference: text("provider_reference"),
    outcomeReceivedAt: timestamp("outcome_received_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("external_actions_tenant_action_id_unique").on(
      table.tenantId,
      table.actionId,
    ),
    unique("external_actions_tenant_idempotency_key_unique").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    // Required by the tenant-scoped child foreign key on external_action_events.
    unique("external_actions_tenant_id_id_unique").on(table.tenantId, table.id),
    index("external_actions_tenant_state_updated_idx").on(
      table.tenantId,
      table.state,
      table.updatedAt.desc(),
    ),
    index("external_actions_tenant_retry_idx").on(
      table.tenantId,
      table.nextRetryAt,
    ),
    index("external_actions_tenant_execution_idx").on(
      table.tenantId,
      table.executionId,
    ),
    check(
      "external_actions_state_check",
      sql`${table.state} IN ('requested', 'dispatching', 'retry_scheduled', 'dispatched', 'completed', 'failed')`,
    ),
    check(
      "external_actions_dispatch_attempts_check",
      sql`${table.dispatchAttempts} >= 0`,
    ),
  ],
);

export type ExternalAction = typeof externalActions.$inferSelect;
export type NewExternalAction = typeof externalActions.$inferInsert;

// ─── external_action_events ───────────────────────────────────────────────
//
// Append-only action transition log.  `event_key` is idempotent per action,
// allowing webhook retries and outbox redelivery without duplicating audit
// entries or reapplying a terminal outcome.

export const externalActionEvents = growthos.table(
  "external_action_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    externalActionId: uuid("external_action_id").notNull(),
    eventKey: text("event_key").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload")
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.externalActionId],
      foreignColumns: [externalActions.tenantId, externalActions.id],
      name: "external_action_events_tenant_action_fk",
    }).onDelete("cascade"),
    unique("external_action_events_tenant_action_event_key_unique").on(
      table.tenantId,
      table.externalActionId,
      table.eventKey,
    ),
    index("external_action_events_tenant_action_created_idx").on(
      table.tenantId,
      table.externalActionId,
      table.createdAt.desc(),
    ),
  ],
);

export type ExternalActionEvent = typeof externalActionEvents.$inferSelect;
export type NewExternalActionEvent = typeof externalActionEvents.$inferInsert;
