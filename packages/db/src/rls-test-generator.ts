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
];
