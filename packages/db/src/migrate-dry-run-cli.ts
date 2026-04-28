/**
 * Applies bootstrap SQL + the bundled Drizzle migration to DATABASE_URL,
 * then verifies core tables exist. Used locally and in CI (same code path).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { splitDrizzleMigrationSql } from "./split-drizzle-migration-sql.js";

const { Client } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");

const CORE_TABLES = [
  "approval_feedback",
  "event_outbox",
  "motion_scores",
  "motion_stack",
  "workflow_runs",
] as const;

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
  const migrationPath =
    process.env.GROWTHOS_MIGRATE_SQL?.trim() ||
    path.join(packageRoot, "drizzle", "0000_yielding_inertia.sql");

  const bootstrapSql = readFileSync(bootstrapPath, "utf8");
  const migrationSql = readFileSync(migrationPath, "utf8");
  const statements = splitDrizzleMigrationSql(migrationSql);

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query(bootstrapSql);

    for (const statement of statements) {
      await client.query(statement);
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
    `migrate-dry-run: ok (${statements.length} migration chunks, ${CORE_TABLES.length} tables verified).`,
  );
}

main().catch((err: unknown) => {
  console.error("migrate-dry-run:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
