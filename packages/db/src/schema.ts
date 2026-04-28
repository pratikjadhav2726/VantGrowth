import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  index,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  unique,
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
