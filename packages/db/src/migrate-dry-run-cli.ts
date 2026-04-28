/**
 * Applies bootstrap SQL + ALL Drizzle migrations in the drizzle/ directory
 * (lexicographic order) to DATABASE_URL, then verifies core tables exist.
 * Used locally and in CI on the same code path.
 *
 * Discovery logic: scans `drizzle/` for *.sql files sorted by name so each new
 * migration added via `drizzle-kit generate` is automatically applied without
 * any script change.  The legacy GROWTHOS_MIGRATE_SQL env override still works
 * for pointing at a single file (backward-compatible for CI overrides).
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { splitDrizzleMigrationSql } from "./split-drizzle-migration-sql.js";

const { Client } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");

/**
 * All tables that must exist after a complete migration run.
 * Add new tenant-scoped tables here when they are added to schema.ts.
 */
const CORE_TABLES = [
  "approval_feedback",
  "event_outbox",
  "motion_scores",
  "motion_stack",
  "playbook_versions",
  "signal_events",
  "workflow_runs",
] as const;

/** Resolve the ordered list of SQL migration files to apply. */
function resolveMigrationFiles(drizzleDir: string): string[] {
  // Legacy env override: single explicit file (keeps CI override paths working).
  const explicitPath = process.env.GROWTHOS_MIGRATE_SQL?.trim();
  if (explicitPath) return [explicitPath];

  return readdirSync(drizzleDir)
    .filter((f) => f.endsWith(".sql"))
    .sort() // lexicographic = chronological for Drizzle's 0000_, 0001_, ... naming
    .map((f) => path.join(drizzleDir, f));
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error(
      "migrate-dry-run: set DATABASE_URL (PostgreSQL connection string).",
    );
    process.exitCode = 1;
    return;
  }

  const bootstrapPath =
    process.env.GROWTHOS_MIGRATE_BOOTSTRAP_SQL?.trim() ||
    path.join(packageRoot, "ci", "bootstrap.sql");
  const drizzleDir = path.join(packageRoot, "drizzle");
  const migrationFiles = resolveMigrationFiles(drizzleDir);

  const bootstrapSql = readFileSync(bootstrapPath, "utf8");

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  let totalChunks = 0;
  try {
    await client.query(bootstrapSql);

    for (const migrationFile of migrationFiles) {
      const migrationSql = readFileSync(migrationFile, "utf8");
      const statements = splitDrizzleMigrationSql(migrationSql);
      for (const statement of statements) {
        await client.query(statement);
      }
      totalChunks += statements.length;
    }

    for (const table of CORE_TABLES) {
      const { rows } = await client.query<{ ok: boolean }>(
        `SELECT to_regclass('growthos.' || $1::text) IS NOT NULL AS ok`,
        [table],
      );
      if (!rows[0]?.ok) {
        throw new Error(
          `Expected table growthos.${table} to exist after migration.`,
        );
      }
    }
  } finally {
    await client.end();
  }

  console.log(
    `migrate-dry-run: ok (${migrationFiles.length} files, ${totalChunks} chunks, ${CORE_TABLES.length} tables verified).`,
  );
}

main().catch((err: unknown) => {
  console.error("migrate-dry-run:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
