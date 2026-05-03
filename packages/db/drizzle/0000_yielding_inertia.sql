CREATE TABLE "growthos"."approval_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"output_type" text NOT NULL,
	"action" text NOT NULL,
	"edit_distance" numeric(6, 4),
	"rubric_failures" text[] DEFAULT '{}'::text[] NOT NULL,
	"reviewer_note" text,
	"learn_opt_in" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_feedback_action_check" CHECK ("growthos"."approval_feedback"."action" IN ('approved', 'edited_then_approved', 'rejected', 'auto_approved'))
);
--> statement-breakpoint
CREATE TABLE "growthos"."event_outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "event_outbox_idempotency_unique" UNIQUE("tenant_id","event_type","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "growthos"."motion_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"scored_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scorer_version" text NOT NULL,
	"scores" jsonb NOT NULL,
	"inputs_digest" text NOT NULL,
	"rationale" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "growthos"."motion_stack" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"primary_motions" text[] NOT NULL,
	"secondary_motions" text[] NOT NULL,
	"observe_only" text[] DEFAULT '{}'::text[] NOT NULL,
	"deactivated" text[] DEFAULT '{}'::text[] NOT NULL,
	"source_score_id" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"version" numeric DEFAULT '1' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "motion_stack_tenant_version_unique" UNIQUE("tenant_id","version")
);
--> statement-breakpoint
CREATE TABLE "growthos"."workflow_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workflow_id" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"state" text DEFAULT 'requested' NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_runs_tenant_workflow_unique" UNIQUE("tenant_id","workflow_id"),
	CONSTRAINT "workflow_runs_state_check" CHECK ("growthos"."workflow_runs"."state" IN ('requested', 'in_progress', 'completed', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "growthos"."motion_stack" ADD CONSTRAINT "motion_stack_source_score_id_motion_scores_id_fk" FOREIGN KEY ("source_score_id") REFERENCES "growthos"."motion_scores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_feedback_tenant_output_created_idx" ON "growthos"."approval_feedback" USING btree ("tenant_id","output_type","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "event_outbox_unconsumed_idx" ON "growthos"."event_outbox" USING btree ("tenant_id","consumed_at","id");--> statement-breakpoint
CREATE INDEX "motion_scores_tenant_scored_at_idx" ON "growthos"."motion_scores" USING btree ("tenant_id","scored_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "motion_stack_tenant_version_idx" ON "growthos"."motion_stack" USING btree ("tenant_id","version" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "workflow_runs_tenant_state_updated_idx" ON "growthos"."workflow_runs" USING btree ("tenant_id","state","updated_at" DESC NULLS LAST);
--> statement-breakpoint
-- ── Row-Level Security ────────────────────────────────────────────────────────
-- All tenant-scoped tables enforce RLS so cross-tenant queries are blocked at
-- the database level. The app sets app.tenant_id, app.actor_id, app.actor_kind
-- as local session variables inside every transaction via set_config().
ALTER TABLE "growthos"."approval_feedback" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "growthos"."approval_feedback" FORCE ROW LEVEL SECURITY;
CREATE POLICY approval_feedback_tenant_isolation ON "growthos"."approval_feedback"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "growthos"."event_outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "growthos"."event_outbox" FORCE ROW LEVEL SECURITY;
CREATE POLICY event_outbox_tenant_isolation ON "growthos"."event_outbox"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "growthos"."motion_scores" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "growthos"."motion_scores" FORCE ROW LEVEL SECURITY;
CREATE POLICY motion_scores_tenant_isolation ON "growthos"."motion_scores"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "growthos"."motion_stack" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "growthos"."motion_stack" FORCE ROW LEVEL SECURITY;
CREATE POLICY motion_stack_tenant_isolation ON "growthos"."motion_stack"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "growthos"."workflow_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "growthos"."workflow_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_runs_tenant_isolation ON "growthos"."workflow_runs"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);