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
