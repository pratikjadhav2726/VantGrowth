/**
 * RLS Invariant Test Generator — Principle 1.6
 *
 * Deriving test cases from schema metadata rather than hand-writing them
 * ensures:
 *   - Every tenant-scoped table is covered automatically.
 *   - Adding a new table only requires a single RlsTableSpec entry.
 *   - All three invariants (owner reads own rows, other tenant blocked,
 *     no-context blocked) are applied uniformly.
 *
 * Usage: import TABLE_SPECS and generateRlsInvariantCases() in the integration
 * test. The test runner drives each generated case via describe.each().
 */

export interface RlsTableSpec {
  /** Fully-qualified table name: "<schema>.<table>" */
  qualifiedName: string;
  /** Column that stores the owning tenant UUID */
  tenantIdColumn: string;
  /**
   * Minimal INSERT SQL that creates one row for the given tenant.
   * $1 = tenantId (UUID text).
   * Must be idempotent via ON CONFLICT DO NOTHING where a unique key exists.
   */
  insertSql: string;
  /**
   * Cleanup SQL to remove all RLS-test rows for the given tenant.
   * $1 = tenantId (UUID text).
   * Executed with app.tenant_id set to ownerTenantId so it passes RLS.
   */
  cleanupSql: string;
}

export type RlsInvariant =
  | "owner_can_read"
  | "other_tenant_blocked"
  | "no_context_blocked";

export interface RlsInvariantCase {
  readonly invariant: RlsInvariant;
  readonly table: RlsTableSpec;
  readonly ownerTenantId: string;
  readonly otherTenantId: string;
  /** Human-readable label for test output */
  readonly label: string;
}

/**
 * Generates three invariant cases per table:
 *  1. owner_can_read        — ownerTenantId context sees 1+ rows
 *  2. other_tenant_blocked  — otherTenantId context sees 0 rows
 *  3. no_context_blocked    — no app.tenant_id set sees 0 rows (FORCE RLS)
 */
export const generateRlsInvariantCases = (
  tables: RlsTableSpec[],
  ownerTenantId: string,
  otherTenantId: string,
): RlsInvariantCase[] =>
  tables.flatMap((table) => [
    {
      invariant: "owner_can_read",
      table,
      ownerTenantId,
      otherTenantId,
      label: `${table.qualifiedName}: owner tenant reads own rows`,
    },
    {
      invariant: "other_tenant_blocked",
      table,
      ownerTenantId,
      otherTenantId,
      label: `${table.qualifiedName}: other tenant sees zero rows`,
    },
    {
      invariant: "no_context_blocked",
      table,
      ownerTenantId,
      otherTenantId,
      label: `${table.qualifiedName}: no tenant context sees zero rows (FORCE RLS)`,
    },
  ]);

// ---------------------------------------------------------------------------
// Schema-derived table specs for all GrowthOS tenant-scoped tables.
// When adding a new table with a tenant_id column + RLS policy, append here.
// ---------------------------------------------------------------------------

export const GROWTHOS_RLS_TABLE_SPECS: RlsTableSpec[] = [
  {
    qualifiedName: "growthos.motion_scores",
    tenantIdColumn: "tenant_id",
    insertSql: `
      INSERT INTO growthos.motion_scores
        (tenant_id, scorer_version, scores, inputs_digest, rationale)
      VALUES
        ($1, 'rls-test-v1', '{}'::jsonb, 'rls-test-digest', ARRAY[]::text[])
      ON CONFLICT DO NOTHING
    `,
    cleanupSql: `DELETE FROM growthos.motion_scores WHERE tenant_id = $1::uuid AND scorer_version = 'rls-test-v1'`,
  },
  {
    qualifiedName: "growthos.motion_stack",
    tenantIdColumn: "tenant_id",
    insertSql: `
      INSERT INTO growthos.motion_stack
        (tenant_id, primary_motions, secondary_motions, observe_only, deactivated, version)
      VALUES
        ($1, ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], 999)
      ON CONFLICT DO NOTHING
    `,
    cleanupSql:
      "DELETE FROM growthos.motion_stack WHERE tenant_id = $1::uuid AND version = 999",
  },
  {
    qualifiedName: "growthos.approval_feedback",
    tenantIdColumn: "tenant_id",
    insertSql: `
      INSERT INTO growthos.approval_feedback
        (tenant_id, issue_id, output_type, action)
      VALUES
        ($1, 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'rls_test', 'approved')
    `,
    cleanupSql: `DELETE FROM growthos.approval_feedback WHERE tenant_id = $1::uuid AND output_type = 'rls_test'`,
  },
  {
    qualifiedName: "growthos.event_outbox",
    tenantIdColumn: "tenant_id",
    insertSql: `
      INSERT INTO growthos.event_outbox
        (tenant_id, event_type, idempotency_key, payload)
      VALUES
        ($1, 'growthos.rls_test.v1', 'rls-invariant-test-v1', '{}'::jsonb)
      ON CONFLICT DO NOTHING
    `,
    cleanupSql: `DELETE FROM growthos.event_outbox WHERE tenant_id = $1::uuid AND event_type = 'growthos.rls_test.v1'`,
  },
  {
    qualifiedName: "growthos.workflow_runs",
    tenantIdColumn: "tenant_id",
    insertSql: `
      INSERT INTO growthos.workflow_runs
        (tenant_id, workflow_id, dedupe_key, state)
      VALUES
        ($1, 'rls-test-workflow-run', 'rls-invariant-test-v1', 'requested')
      ON CONFLICT DO NOTHING
    `,
    cleanupSql: `DELETE FROM growthos.workflow_runs WHERE tenant_id = $1::uuid AND workflow_id = 'rls-test-workflow-run'`,
  },
  {
    qualifiedName: "growthos.playbook_versions",
    tenantIdColumn: "tenant_id",
    insertSql: `
      INSERT INTO growthos.playbook_versions
        (tenant_id, playbook_type, version, name, content, created_by)
      VALUES
        ($1, 'custom', 0, 'rls-test-playbook', '{}'::jsonb, 'rls-test')
      ON CONFLICT DO NOTHING
    `,
    cleanupSql: `DELETE FROM growthos.playbook_versions WHERE tenant_id = $1::uuid AND name = 'rls-test-playbook'`,
  },
  {
    qualifiedName: "growthos.signal_events",
    tenantIdColumn: "tenant_id",
    insertSql: `
      INSERT INTO growthos.signal_events
        (tenant_id, signal_type, source, payload)
      VALUES
        ($1, 'internal', 'rls-test', '{}'::jsonb)
    `,
    cleanupSql: `DELETE FROM growthos.signal_events WHERE tenant_id = $1::uuid AND source = 'rls-test'`,
  },
  {
    qualifiedName: "growthos.tenant_settings",
    tenantIdColumn: "tenant_id",
    insertSql: `
      INSERT INTO growthos.tenant_settings
        (tenant_id, settings)
      VALUES
        ($1, '{"rlsTest": true}'::jsonb)
      ON CONFLICT (tenant_id) DO UPDATE SET settings = EXCLUDED.settings
    `,
    cleanupSql:
      "DELETE FROM growthos.tenant_settings WHERE tenant_id = $1::uuid",
  },
  {
    qualifiedName: "growthos.experiments",
    tenantIdColumn: "tenant_id",
    insertSql: `
      INSERT INTO growthos.experiments
        (tenant_id, experiment_key, motion, experiment_type, unit_type, hypothesis,
         variant_a, variant_b, metric_name, min_sample_size, created_by)
      VALUES
        ($1, 'rls-test-experiment-root', 'rls_test', 'ab', 'account',
         'RLS isolation remains enforced for experiment state.',
         '{}'::jsonb, '{}'::jsonb, 'qualified_pipeline', 1, 'rls-test')
      ON CONFLICT DO NOTHING
    `,
    cleanupSql: `DELETE FROM growthos.experiments WHERE tenant_id = $1::uuid AND experiment_key = 'rls-test-experiment-root'`,
  },
  {
    qualifiedName: "growthos.experiment_assignments",
    tenantIdColumn: "tenant_id",
    insertSql: `
      WITH experiment AS (
        INSERT INTO growthos.experiments
          (tenant_id, experiment_key, motion, experiment_type, unit_type, hypothesis,
           variant_a, variant_b, metric_name, min_sample_size, created_by)
        VALUES
          ($1, 'rls-test-experiment-assignment', 'rls_test', 'ab', 'account',
           'Assignment fixture requires a tenant-scoped parent experiment.',
           '{}'::jsonb, '{}'::jsonb, 'qualified_pipeline', 1, 'rls-test')
        ON CONFLICT (tenant_id, experiment_key) DO UPDATE
          SET updated_at = now()
        RETURNING id
      )
      INSERT INTO growthos.experiment_assignments
        (tenant_id, experiment_id, entity_type, entity_id, variant)
      SELECT $1, id, 'account', 'rls-test-account', 'a'
      FROM experiment
      ON CONFLICT DO NOTHING
    `,
    cleanupSql: `DELETE FROM growthos.experiments WHERE tenant_id = $1::uuid AND experiment_key = 'rls-test-experiment-assignment'`,
  },
  {
    qualifiedName: "growthos.experiment_observations",
    tenantIdColumn: "tenant_id",
    insertSql: `
      WITH experiment AS (
        INSERT INTO growthos.experiments
          (tenant_id, experiment_key, motion, experiment_type, unit_type, hypothesis,
           variant_a, variant_b, metric_name, min_sample_size, created_by, status)
        VALUES
          ($1, 'rls-test-experiment-observation', 'rls_test', 'ab', 'account',
           'Observation fixture requires a tenant-scoped parent experiment.',
           '{}'::jsonb, '{}'::jsonb, 'qualified_pipeline', 1, 'rls-test', 'running')
        ON CONFLICT (tenant_id, experiment_key) DO UPDATE
          SET updated_at = now()
        RETURNING id
      ), assignment AS (
        INSERT INTO growthos.experiment_assignments
          (tenant_id, experiment_id, entity_type, entity_id, variant)
        SELECT $1, id, 'account', 'rls-test-account', 'a'
        FROM experiment
        ON CONFLICT (tenant_id, experiment_id, entity_type, entity_id) DO UPDATE
          SET exposed_at = EXCLUDED.exposed_at
        RETURNING id, experiment_id
      )
      INSERT INTO growthos.experiment_observations
        (tenant_id, experiment_id, assignment_id, idempotency_key, entity_type,
         entity_id, variant, metric_name, metric_value, attribution_confidence,
         attribution_model, source)
      SELECT $1, experiment_id, id, 'rls-test-observation-v1', 'account',
             'rls-test-account', 'a', 'qualified_pipeline', 1, 1,
             'direct', 'rls-test'
      FROM assignment
      ON CONFLICT DO NOTHING
    `,
    cleanupSql: `DELETE FROM growthos.experiments WHERE tenant_id = $1::uuid AND experiment_key = 'rls-test-experiment-observation'`,
  },
  {
    qualifiedName: "growthos.learning_proposals",
    tenantIdColumn: "tenant_id",
    insertSql: `
      INSERT INTO growthos.learning_proposals
        (tenant_id, proposal_key, target_type, target_id, risk, proposal_payload, created_by)
      VALUES
        ($1, 'rls-test-learning-proposal', 'playbook', 'rls-test-playbook',
         'low', '{}'::jsonb, 'rls-test')
      ON CONFLICT DO NOTHING
    `,
    cleanupSql: `DELETE FROM growthos.learning_proposals WHERE tenant_id = $1::uuid AND proposal_key = 'rls-test-learning-proposal'`,
  },
  {
    qualifiedName: "growthos.component_health",
    tenantIdColumn: "tenant_id",
    insertSql: `
      INSERT INTO growthos.component_health
        (tenant_id, component_id, idempotency_key, state, error_rate,
         consecutive_failures, p95_latency_ms, staleness_seconds,
         dependency_available, fallback_available, last_known_good_available,
         recovery_attempts, action, allow_external_actions, reasons)
      VALUES
        ($1, 'rls-test-component', 'rls-test-health-v1', 'healthy', 0,
         0, 0, 0, true, false, true, 0, 'none', true, ARRAY['fixture']::text[])
      ON CONFLICT DO NOTHING
    `,
    cleanupSql: `DELETE FROM growthos.component_health WHERE tenant_id = $1::uuid AND component_id = 'rls-test-component'`,
  },
  {
    qualifiedName: "growthos.incidents",
    tenantIdColumn: "tenant_id",
    insertSql: `
      INSERT INTO growthos.incidents
        (tenant_id, incident_key, component_id, severity, title, summary)
      VALUES
        ($1, 'rls-test-incident', 'rls-test-component', 'low',
         'RLS fixture incident', 'Tenant isolation fixture')
      ON CONFLICT DO NOTHING
    `,
    cleanupSql: `DELETE FROM growthos.incidents WHERE tenant_id = $1::uuid AND incident_key = 'rls-test-incident'`,
  },
  {
    qualifiedName: "growthos.external_actions",
    tenantIdColumn: "tenant_id",
    insertSql: `
      INSERT INTO growthos.external_actions
        (tenant_id, action_id, idempotency_key, request_digest, action_type,
         approved_by, request_payload)
      VALUES
        ($1, 'rls-test-external-action', 'rls-test-external-action',
         repeat('a', 64), 'custom.execute', 'rls-test', '{}'::jsonb)
      ON CONFLICT DO NOTHING
    `,
    cleanupSql: `DELETE FROM growthos.external_actions WHERE tenant_id = $1::uuid AND action_id = 'rls-test-external-action'`,
  },
  {
    qualifiedName: "growthos.external_action_events",
    tenantIdColumn: "tenant_id",
    insertSql: `
      WITH action AS (
        INSERT INTO growthos.external_actions
          (tenant_id, action_id, idempotency_key, request_digest, action_type,
           approved_by, request_payload)
        VALUES
          ($1, 'rls-test-external-action-event',
           'rls-test-external-action-event', repeat('b', 64),
           'custom.execute', 'rls-test', '{}'::jsonb)
        ON CONFLICT (tenant_id, action_id) DO UPDATE
          SET updated_at = now()
        RETURNING id
      )
      INSERT INTO growthos.external_action_events
        (tenant_id, external_action_id, event_key, event_type, payload)
      SELECT $1, id, 'rls-test-event', 'requested', '{}'::jsonb
      FROM action
      ON CONFLICT DO NOTHING
    `,
    cleanupSql: `DELETE FROM growthos.external_actions WHERE tenant_id = $1::uuid AND action_id = 'rls-test-external-action-event'`,
  },
];
