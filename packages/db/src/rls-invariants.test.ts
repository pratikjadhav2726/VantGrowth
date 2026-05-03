/**
 * RLS Invariant Integration Tests — Principle 1.6
 *
 * These tests verify that all tenant-scoped GrowthOS tables enforce
 * Row-Level Security correctly. Test cases are generated from
 * GROWTHOS_RLS_TABLE_SPECS rather than hand-written, so coverage is
 * automatically maintained as the schema grows.
 *
 * Requirements:
 *   - Skipped when DATABASE_URL is not set (unit test / CI without DB)
 *   - Run with a live Postgres: DATABASE_URL=... pnpm --filter @growthos/db test
 *
 * Three invariants verified per table:
 *   1. owner_can_read        — context matches row's tenant → SELECT returns row
 *   2. other_tenant_blocked  — different tenant context → SELECT returns nothing
 *   3. no_context_blocked    — no app.tenant_id set → SELECT returns nothing (FORCE RLS)
 *
 * Isolation strategy:
 *   - setup: INSERT rows via dedicated "owner" pg.Client with SET "app.tenant_id"
 *   - cross-tenant check: dedicated "other" pg.Client with different SET
 *   - no-context check: dedicated "anon" pg.Client with no SET
 *   - teardown: DELETE via owner client after all invariants for a table run
 */

import { Client } from "pg";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";
import {
  GROWTHOS_RLS_TABLE_SPECS,
  generateRlsInvariantCases,
} from "./rls-test-generator.js";

// Well-known UUIDs scoped to the RLS test namespace — distinct from the dev
// seed tenant so concurrent seed:dev runs cannot interfere.
const OWNER_TENANT_ID = "00000000-0000-0000-0099-000000000001";
const OTHER_TENANT_ID = "00000000-0000-0000-0099-000000000002";

const DATABASE_URL = process.env.DATABASE_URL;

// Helper: create and connect a pg.Client configured with an optional tenant context.
const makeClient = async (tenantId?: string): Promise<Client> => {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  if (tenantId !== undefined) {
    // SET (session-scoped) persists for the lifetime of the connection,
    // which is what we want for the test assertions below.
    await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [
      tenantId,
    ]);
  }
  return client;
};

const closeClient = async (client: Client): Promise<void> => {
  try {
    await client.end();
  } catch {
    // ignore close errors
  }
};

// Count rows visible under the current session's RLS context.
const countVisible = async (
  client: Client,
  qualifiedName: string,
): Promise<number> => {
  const res = await client.query(
    `SELECT count(*)::int AS n FROM ${qualifiedName}`,
  );
  return (res.rows[0] as { n: number }).n;
};

describe.skipIf(!DATABASE_URL)("RLS invariants (integration)", () => {
  const allCases = generateRlsInvariantCases(
    GROWTHOS_RLS_TABLE_SPECS,
    OWNER_TENANT_ID,
    OTHER_TENANT_ID,
  );

  // Group cases by table so we share one setup/teardown connection per table.
  const byTable = allCases.reduce<Map<string, typeof allCases>>((acc, c) => {
    const group = acc.get(c.table.qualifiedName) ?? [];
    group.push(c);
    acc.set(c.table.qualifiedName, group);
    return acc;
  }, new Map());

  for (const [qualifiedName, cases] of byTable) {
    // cases is always non-empty because we grouped from allCases
    const spec = (cases[0] as (typeof allCases)[0]).table;

    describe(qualifiedName, () => {
      let ownerClient: Client;
      let otherClient: Client;
      let anonClient: Client;

      beforeAll(async () => {
        ownerClient = await makeClient(OWNER_TENANT_ID);
        otherClient = await makeClient(OTHER_TENANT_ID);
        anonClient = await makeClient(); // no tenant context

        // Insert test fixture for the owner tenant.
        // With FORCE RLS, app.tenant_id must be set for the INSERT to pass
        // the WITH CHECK policy. The ownerClient already has it set above.
        await ownerClient.query(spec.insertSql, [OWNER_TENANT_ID]);
      });

      afterAll(async () => {
        // Clean up test rows via owner context (RLS-safe DELETE).
        await ownerClient.query(spec.cleanupSql, [OWNER_TENANT_ID]);
        await closeClient(ownerClient);
        await closeClient(otherClient);
        await closeClient(anonClient);
      });

      for (const tc of cases) {
        it(tc.label, async () => {
          switch (tc.invariant) {
            case "owner_can_read": {
              const n = await countVisible(ownerClient, qualifiedName);
              expect(
                n,
                `owner should see at least 1 row in ${qualifiedName}`,
              ).toBeGreaterThanOrEqual(1);
              break;
            }
            case "other_tenant_blocked": {
              const n = await countVisible(otherClient, qualifiedName);
              expect(
                n,
                `other tenant must see 0 rows in ${qualifiedName}`,
              ).toBe(0);
              break;
            }
            case "no_context_blocked": {
              // With FORCE RLS, current_setting('app.tenant_id', true) returns NULL
              // when not set. NULL = UUID evaluates to NULL (falsy) -> no rows pass.
              const n = await countVisible(anonClient, qualifiedName);
              expect(
                n,
                `no-context session must see 0 rows in ${qualifiedName}`,
              ).toBe(0);
              break;
            }
          }
        });
      }
    });
  }
});
