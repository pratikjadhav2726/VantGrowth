CREATE TABLE "growthos"."component_health" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"component_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"state" text NOT NULL,
	"error_rate" numeric(5, 4) NOT NULL,
	"consecutive_failures" integer NOT NULL,
	"p95_latency_ms" integer NOT NULL,
	"staleness_seconds" integer NOT NULL,
	"dependency_available" boolean NOT NULL,
	"fallback_available" boolean NOT NULL,
	"last_known_good_available" boolean NOT NULL,
	"last_known_good_version_ref" text,
	"recovery_attempts" integer NOT NULL,
	"guardrail_breached" boolean DEFAULT false NOT NULL,
	"action" text NOT NULL,
	"allow_external_actions" boolean NOT NULL,
	"retry_after_seconds" integer,
	"reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "component_health_tenant_component_idempotency_unique" UNIQUE("tenant_id","component_id","idempotency_key"),
	CONSTRAINT "component_health_state_check" CHECK ("growthos"."component_health"."state" IN ('healthy', 'degraded', 'recovering', 'quarantined')),
	CONSTRAINT "component_health_action_check" CHECK ("growthos"."component_health"."action" IN ('none', 'resume', 'retry_with_backoff', 'use_fallback', 'rollback', 'quarantine_and_escalate')),
	CONSTRAINT "component_health_error_rate_check" CHECK ("growthos"."component_health"."error_rate" >= 0 AND "growthos"."component_health"."error_rate" <= 1),
	CONSTRAINT "component_health_nonnegative_values_check" CHECK ("growthos"."component_health"."consecutive_failures" >= 0 AND "growthos"."component_health"."p95_latency_ms" >= 0 AND "growthos"."component_health"."staleness_seconds" >= 0 AND "growthos"."component_health"."recovery_attempts" >= 0),
	CONSTRAINT "component_health_retry_after_check" CHECK ("growthos"."component_health"."retry_after_seconds" IS NULL OR "growthos"."component_health"."retry_after_seconds" > 0)
);
--> statement-breakpoint
CREATE TABLE "growthos"."experiment_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"experiment_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"variant" text NOT NULL,
	"assignment_context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"exposed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "experiment_assignments_tenant_experiment_entity_unique" UNIQUE("tenant_id","experiment_id","entity_type","entity_id"),
	CONSTRAINT "experiment_assignments_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "experiment_assignments_variant_check" CHECK ("growthos"."experiment_assignments"."variant" IN ('a', 'b'))
);
--> statement-breakpoint
CREATE TABLE "growthos"."experiment_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"experiment_id" uuid NOT NULL,
	"assignment_id" uuid,
	"idempotency_key" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"variant" text NOT NULL,
	"metric_name" text NOT NULL,
	"metric_value" numeric(20, 6) NOT NULL,
	"is_guardrail" boolean DEFAULT false NOT NULL,
	"attribution_confidence" numeric(5, 4) NOT NULL,
	"attribution_model" text NOT NULL,
	"source" text NOT NULL,
	"cost_amount" numeric(20, 6),
	"cost_currency" text,
	"observed_outcome" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "experiment_observations_tenant_experiment_idempotency_unique" UNIQUE("tenant_id","experiment_id","idempotency_key"),
	CONSTRAINT "experiment_observations_variant_check" CHECK ("growthos"."experiment_observations"."variant" IN ('a', 'b')),
	CONSTRAINT "experiment_observations_attribution_confidence_check" CHECK ("growthos"."experiment_observations"."attribution_confidence" >= 0 AND "growthos"."experiment_observations"."attribution_confidence" <= 1),
	CONSTRAINT "experiment_observations_cost_check" CHECK ("growthos"."experiment_observations"."cost_amount" IS NULL OR "growthos"."experiment_observations"."cost_amount" >= 0),
	CONSTRAINT "experiment_observations_currency_check" CHECK ("growthos"."experiment_observations"."cost_currency" IS NULL OR char_length("growthos"."experiment_observations"."cost_currency") = 3)
);
--> statement-breakpoint
CREATE TABLE "growthos"."experiments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"experiment_key" text NOT NULL,
	"motion" text NOT NULL,
	"experiment_type" text NOT NULL,
	"unit_type" text NOT NULL,
	"hypothesis" text NOT NULL,
	"variant_a" jsonb NOT NULL,
	"variant_b" jsonb NOT NULL,
	"metric_name" text NOT NULL,
	"metric_direction" text DEFAULT 'increase' NOT NULL,
	"min_sample_size" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"winner" text,
	"confidence" numeric(5, 4),
	"input_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"model_version" text,
	"prompt_version" text,
	"playbook_version" text,
	"policy_version" text,
	"created_by" text NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "experiments_tenant_experiment_key_unique" UNIQUE("tenant_id","experiment_key"),
	CONSTRAINT "experiments_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "experiments_status_check" CHECK ("growthos"."experiments"."status" IN ('draft', 'running', 'paused', 'concluded', 'abandoned', 'promoted', 'rolled_back')),
	CONSTRAINT "experiments_winner_check" CHECK ("growthos"."experiments"."winner" IS NULL OR "growthos"."experiments"."winner" IN ('a', 'b', 'inconclusive')),
	CONSTRAINT "experiments_metric_direction_check" CHECK ("growthos"."experiments"."metric_direction" IN ('increase', 'decrease')),
	CONSTRAINT "experiments_min_sample_size_check" CHECK ("growthos"."experiments"."min_sample_size" > 0),
	CONSTRAINT "experiments_confidence_check" CHECK ("growthos"."experiments"."confidence" IS NULL OR ("growthos"."experiments"."confidence" >= 0 AND "growthos"."experiments"."confidence" <= 1))
);
--> statement-breakpoint
CREATE TABLE "growthos"."incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"incident_key" text NOT NULL,
	"component_id" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"action" text,
	"rollback_version_ref" text,
	"diagnostic_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incidents_tenant_incident_key_unique" UNIQUE("tenant_id","incident_key"),
	CONSTRAINT "incidents_severity_check" CHECK ("growthos"."incidents"."severity" IN ('low', 'medium', 'high', 'critical')),
	CONSTRAINT "incidents_status_check" CHECK ("growthos"."incidents"."status" IN ('open', 'acknowledged', 'mitigated', 'resolved')),
	CONSTRAINT "incidents_action_check" CHECK ("growthos"."incidents"."action" IS NULL OR "growthos"."incidents"."action" IN ('none', 'resume', 'retry_with_backoff', 'use_fallback', 'rollback', 'quarantine_and_escalate'))
);
--> statement-breakpoint
CREATE TABLE "growthos"."learning_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"proposal_key" text NOT NULL,
	"experiment_id" uuid,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"risk" text NOT NULL,
	"status" text DEFAULT 'awaiting_evidence' NOT NULL,
	"proposal_payload" jsonb NOT NULL,
	"evidence_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evaluation_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"decision" text,
	"decision_reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"base_version_ref" text,
	"candidate_version_ref" text,
	"promoted_version_ref" text,
	"rollback_version_ref" text,
	"human_approved_by" text,
	"human_approved_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"evaluated_at" timestamp with time zone,
	"promoted_at" timestamp with time zone,
	"rolled_back_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_proposals_tenant_proposal_key_unique" UNIQUE("tenant_id","proposal_key"),
	CONSTRAINT "learning_proposals_status_check" CHECK ("growthos"."learning_proposals"."status" IN ('awaiting_evidence', 'evaluating', 'requires_approval', 'approved', 'rejected', 'promoted', 'rolled_back')),
	CONSTRAINT "learning_proposals_risk_check" CHECK ("growthos"."learning_proposals"."risk" IN ('low', 'medium', 'high', 'critical')),
	CONSTRAINT "learning_proposals_decision_check" CHECK ("growthos"."learning_proposals"."decision" IS NULL OR "growthos"."learning_proposals"."decision" IN ('continue_experiment', 'reject', 'requires_approval', 'promote'))
);
--> statement-breakpoint
ALTER TABLE "growthos"."experiment_assignments" ADD CONSTRAINT "experiment_assignments_tenant_experiment_fk" FOREIGN KEY ("tenant_id","experiment_id") REFERENCES "growthos"."experiments"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growthos"."experiment_observations" ADD CONSTRAINT "experiment_observations_tenant_experiment_fk" FOREIGN KEY ("tenant_id","experiment_id") REFERENCES "growthos"."experiments"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growthos"."experiment_observations" ADD CONSTRAINT "experiment_observations_tenant_assignment_fk" FOREIGN KEY ("tenant_id","assignment_id") REFERENCES "growthos"."experiment_assignments"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growthos"."learning_proposals" ADD CONSTRAINT "learning_proposals_tenant_experiment_fk" FOREIGN KEY ("tenant_id","experiment_id") REFERENCES "growthos"."experiments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "component_health_tenant_component_observed_idx" ON "growthos"."component_health" USING btree ("tenant_id","component_id","observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "component_health_tenant_state_observed_idx" ON "growthos"."component_health" USING btree ("tenant_id","state","observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "experiment_assignments_tenant_experiment_variant_idx" ON "growthos"."experiment_assignments" USING btree ("tenant_id","experiment_id","variant");--> statement-breakpoint
CREATE INDEX "experiment_assignments_tenant_entity_idx" ON "growthos"."experiment_assignments" USING btree ("tenant_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "experiment_observations_tenant_experiment_metric_observed_idx" ON "growthos"."experiment_observations" USING btree ("tenant_id","experiment_id","metric_name","observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "experiment_observations_tenant_experiment_variant_idx" ON "growthos"."experiment_observations" USING btree ("tenant_id","experiment_id","variant");--> statement-breakpoint
CREATE INDEX "experiments_tenant_status_updated_idx" ON "growthos"."experiments" USING btree ("tenant_id","status","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "experiments_tenant_motion_created_idx" ON "growthos"."experiments" USING btree ("tenant_id","motion","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "incidents_tenant_status_opened_idx" ON "growthos"."incidents" USING btree ("tenant_id","status","opened_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "incidents_tenant_component_opened_idx" ON "growthos"."incidents" USING btree ("tenant_id","component_id","opened_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "learning_proposals_tenant_status_updated_idx" ON "growthos"."learning_proposals" USING btree ("tenant_id","status","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "learning_proposals_tenant_experiment_idx" ON "growthos"."learning_proposals" USING btree ("tenant_id","experiment_id");
--> statement-breakpoint
-- ── Row-Level Security ────────────────────────────────────────────────────────
-- The control plane carries tenant-private evidence, operational health, and
-- incident diagnostics. All tables are forced through the same session-local
-- app.tenant_id boundary used by the rest of GrowthOS.
ALTER TABLE "growthos"."experiments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "growthos"."experiments" FORCE ROW LEVEL SECURITY;
CREATE POLICY experiments_tenant_isolation ON "growthos"."experiments"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "growthos"."experiment_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "growthos"."experiment_assignments" FORCE ROW LEVEL SECURITY;
CREATE POLICY experiment_assignments_tenant_isolation ON "growthos"."experiment_assignments"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "growthos"."experiment_observations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "growthos"."experiment_observations" FORCE ROW LEVEL SECURITY;
CREATE POLICY experiment_observations_tenant_isolation ON "growthos"."experiment_observations"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "growthos"."learning_proposals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "growthos"."learning_proposals" FORCE ROW LEVEL SECURITY;
CREATE POLICY learning_proposals_tenant_isolation ON "growthos"."learning_proposals"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "growthos"."component_health" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "growthos"."component_health" FORCE ROW LEVEL SECURITY;
CREATE POLICY component_health_tenant_isolation ON "growthos"."component_health"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "growthos"."incidents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "growthos"."incidents" FORCE ROW LEVEL SECURITY;
CREATE POLICY incidents_tenant_isolation ON "growthos"."incidents"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
