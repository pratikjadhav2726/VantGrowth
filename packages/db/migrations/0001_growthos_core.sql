CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS growthos;

CREATE TABLE IF NOT EXISTS growthos.motion_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  scored_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  scorer_version TEXT NOT NULL,
  scores JSONB NOT NULL,
  inputs_digest TEXT NOT NULL,
  rationale TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS growthos.motion_stack (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  primary_motions TEXT[] NOT NULL,
  secondary_motions TEXT[] NOT NULL,
  observe_only TEXT[] NOT NULL DEFAULT '{}',
  deactivated TEXT[] NOT NULL DEFAULT '{}',
  source_score_id UUID REFERENCES growthos.motion_scores(id),
  approved_by UUID,
  approved_at TIMESTAMPTZ,
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, version)
);

CREATE TABLE IF NOT EXISTS growthos.approval_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  issue_id UUID NOT NULL,
  output_type TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('approved', 'edited_then_approved', 'rejected', 'auto_approved')),
  edit_distance NUMERIC(6,4),
  rubric_failures TEXT[] NOT NULL DEFAULT '{}',
  reviewer_note TEXT,
  learn_opt_in BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS growthos.event_outbox (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at TIMESTAMPTZ,
  UNIQUE (tenant_id, event_type, idempotency_key)
);

CREATE INDEX IF NOT EXISTS motion_scores_tenant_scored_at_idx
  ON growthos.motion_scores (tenant_id, scored_at DESC);

CREATE INDEX IF NOT EXISTS motion_stack_tenant_version_idx
  ON growthos.motion_stack (tenant_id, version DESC);

CREATE INDEX IF NOT EXISTS approval_feedback_tenant_output_created_idx
  ON growthos.approval_feedback (tenant_id, output_type, created_at DESC);

CREATE INDEX IF NOT EXISTS event_outbox_unconsumed_idx
  ON growthos.event_outbox (tenant_id, consumed_at NULLS FIRST, id);

ALTER TABLE growthos.motion_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE growthos.motion_scores FORCE ROW LEVEL SECURITY;

ALTER TABLE growthos.motion_stack ENABLE ROW LEVEL SECURITY;
ALTER TABLE growthos.motion_stack FORCE ROW LEVEL SECURITY;

ALTER TABLE growthos.approval_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE growthos.approval_feedback FORCE ROW LEVEL SECURITY;

ALTER TABLE growthos.event_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE growthos.event_outbox FORCE ROW LEVEL SECURITY;

CREATE POLICY motion_scores_tenant_isolation ON growthos.motion_scores
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY motion_stack_tenant_isolation ON growthos.motion_stack
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY approval_feedback_tenant_isolation ON growthos.approval_feedback
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY event_outbox_tenant_isolation ON growthos.event_outbox
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
