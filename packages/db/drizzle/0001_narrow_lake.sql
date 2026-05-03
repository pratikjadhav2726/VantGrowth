CREATE TABLE "growthos"."playbook_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"playbook_type" text NOT NULL,
	"version" numeric(10, 0) NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"content" jsonb NOT NULL,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playbook_versions_tenant_type_version_unique" UNIQUE("tenant_id","playbook_type","version"),
	CONSTRAINT "playbook_versions_type_check" CHECK ("growthos"."playbook_versions"."playbook_type" IN ('content_brief', 'intel_brief', 'blog_draft', 'custom'))
);
--> statement-breakpoint
CREATE TABLE "growthos"."signal_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"signal_type" text NOT NULL,
	"source" text NOT NULL,
	"external_id" text,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signal_events_type_check" CHECK ("growthos"."signal_events"."signal_type" IN ('competitive', 'community', 'icp', 'product', 'market', 'internal'))
);
--> statement-breakpoint
CREATE INDEX "playbook_versions_tenant_type_retired_idx" ON "growthos"."playbook_versions" USING btree ("tenant_id","playbook_type","retired_at");--> statement-breakpoint
CREATE INDEX "signal_events_tenant_type_created_idx" ON "growthos"."signal_events" USING btree ("tenant_id","signal_type","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "signal_events_tenant_unprocessed_idx" ON "growthos"."signal_events" USING btree ("tenant_id","id") WHERE "growthos"."signal_events"."processed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "signal_events_tenant_source_external_uniq" ON "growthos"."signal_events" USING btree ("tenant_id","source","external_id") WHERE "growthos"."signal_events"."external_id" IS NOT NULL;

-- Row-Level Security: tenant isolation for new tables.
-- Same pattern as 0000_yielding_inertia.sql.
ALTER TABLE "growthos"."playbook_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "growthos"."playbook_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY playbook_versions_tenant_isolation ON "growthos"."playbook_versions"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "growthos"."signal_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "growthos"."signal_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY signal_events_tenant_isolation ON "growthos"."signal_events"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);