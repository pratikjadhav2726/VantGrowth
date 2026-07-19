ALTER TABLE "growthos"."signal_events" ADD COLUMN "processing_lease_owner" text;--> statement-breakpoint
ALTER TABLE "growthos"."signal_events" ADD COLUMN "processing_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "growthos"."signal_events" ADD COLUMN "processing_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "signal_events_tenant_claimable_idx" ON "growthos"."signal_events" USING btree ("tenant_id","signal_type","processing_lease_expires_at","id") WHERE "growthos"."signal_events"."processed_at" IS NULL;