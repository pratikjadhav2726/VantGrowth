CREATE TABLE "growthos"."tenant_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "growthos"."tenant_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "growthos"."tenant_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_settings_tenant_isolation ON "growthos"."tenant_settings"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
