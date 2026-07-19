CREATE TABLE "growthos"."external_action_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"external_action_id" uuid NOT NULL,
	"event_key" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_action_events_tenant_action_event_key_unique" UNIQUE("tenant_id","external_action_id","event_key")
);
--> statement-breakpoint
CREATE TABLE "growthos"."external_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"action_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"action_type" text NOT NULL,
	"approved_by" text NOT NULL,
	"request_payload" jsonb NOT NULL,
	"state" text DEFAULT 'requested' NOT NULL,
	"dispatch_attempts" integer DEFAULT 0 NOT NULL,
	"dispatch_lease_owner" text,
	"dispatch_lease_expires_at" timestamp with time zone,
	"last_dispatch_at" timestamp with time zone,
	"next_retry_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_message" text,
	"dispatch_receipt" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outcome" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"workflow_id" text,
	"execution_id" text,
	"provider_reference" text,
	"outcome_received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_actions_tenant_action_id_unique" UNIQUE("tenant_id","action_id"),
	CONSTRAINT "external_actions_tenant_idempotency_key_unique" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "external_actions_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "external_actions_state_check" CHECK ("growthos"."external_actions"."state" IN ('requested', 'dispatching', 'retry_scheduled', 'dispatched', 'completed', 'failed')),
	CONSTRAINT "external_actions_dispatch_attempts_check" CHECK ("growthos"."external_actions"."dispatch_attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "growthos"."external_action_events" ADD CONSTRAINT "external_action_events_tenant_action_fk" FOREIGN KEY ("tenant_id","external_action_id") REFERENCES "growthos"."external_actions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "external_action_events_tenant_action_created_idx" ON "growthos"."external_action_events" USING btree ("tenant_id","external_action_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "external_actions_tenant_state_updated_idx" ON "growthos"."external_actions" USING btree ("tenant_id","state","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "external_actions_tenant_retry_idx" ON "growthos"."external_actions" USING btree ("tenant_id","next_retry_at");--> statement-breakpoint
CREATE INDEX "external_actions_tenant_execution_idx" ON "growthos"."external_actions" USING btree ("tenant_id","execution_id");
--> statement-breakpoint
-- The dispatcher and callback API always establish a transaction-local tenant
-- context before touching this ledger. FORCE RLS makes a missing context fail
-- closed, including for child lifecycle events.
ALTER TABLE "growthos"."external_actions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "growthos"."external_actions" FORCE ROW LEVEL SECURITY;
CREATE POLICY external_actions_tenant_isolation ON "growthos"."external_actions"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "growthos"."external_action_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "growthos"."external_action_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY external_action_events_tenant_isolation ON "growthos"."external_action_events"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
