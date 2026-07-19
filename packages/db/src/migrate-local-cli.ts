/**
 * Applies bootstrap SQL + pending Drizzle SQL migrations to a persistent local
 * database. Unlike migrate-dry-run, this command keeps a migration journal so
 * Docker dev stacks can restart without replaying CREATE TABLE statements.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg, { type Client as PgClient } from "pg";
import { splitDrizzleMigrationSql } from "./split-drizzle-migration-sql.js";

const { Client } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");

const CORE_TABLES = [
  "approval_feedback",
  "component_health",
  "event_outbox",
  "experiment_assignments",
  "experiment_observations",
  "experiments",
  "external_action_events",
  "external_actions",
  "incidents",
  "learning_proposals",
  "motion_scores",
  "motion_stack",
  "playbook_versions",
  "signal_events",
  "tenant_settings",
  "workflow_runs",
] as const;

interface MigrationFile {
  tag: string;
  when: number;
  hash: string;
  path: string;
}

function resolveMigrationFiles(drizzleDir: string): MigrationFile[] {
  const journalPath = path.join(drizzleDir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { tag: string; when: number }[];
  };

  return journal.entries.map((entry) => {
    const migrationPath = path.join(drizzleDir, `${entry.tag}.sql`);
    const sql = readFileSync(migrationPath, "utf8");
    return {
      tag: entry.tag,
      when: entry.when,
      hash: createHash("sha256").update(sql).digest("hex"),
      path: migrationPath,
    };
  });
}

async function coreTablesExist(client: PgClient): Promise<boolean> {
  const { rows } = await client.query<{ table_name: string }>(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'growthos'
        AND table_name = ANY($1::text[])
    `,
    [CORE_TABLES],
  );

  return new Set(rows.map((row) => row.table_name)).size === CORE_TABLES.length;
}

async function ensureMigrationJournal(client: PgClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS "growthos"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    );
  `);
}

async function backfillJournal(
  client: PgClient,
  migrations: MigrationFile[],
): Promise<void> {
  for (const migration of migrations) {
    await client.query(
      `
        INSERT INTO "growthos"."__drizzle_migrations" ("hash", "created_at")
        SELECT $1, $2
        WHERE NOT EXISTS (
          SELECT 1
          FROM "growthos"."__drizzle_migrations"
          WHERE created_at = $2
        )
      `,
      [migration.hash, migration.when],
    );
  }
}

async function applyMigration(
  client: PgClient,
  migration: MigrationFile,
): Promise<number> {
  const migrationSql = readFileSync(migration.path, "utf8");
  const statements = splitDrizzleMigrationSql(migrationSql).filter(
    (statement) => statement.trim().length > 0,
  );

  await client.query("BEGIN");
  try {
    for (const statement of statements) {
      await client.query(statement);
    }
    await client.query(
      `
        INSERT INTO "growthos"."__drizzle_migrations" ("hash", "created_at")
        VALUES ($1, $2)
      `,
      [migration.hash, migration.when],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }

  return statements.length;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error(
      "migrate-local: set DATABASE_URL (PostgreSQL connection string).",
    );
    process.exitCode = 1;
    return;
  }

  const bootstrapPath =
    process.env.GROWTHOS_MIGRATE_BOOTSTRAP_SQL?.trim() ||
    path.join(packageRoot, "ci", "bootstrap.sql");
  const drizzleDir = path.join(packageRoot, "drizzle");
  const migrations = resolveMigrationFiles(drizzleDir);

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  let applied = 0;
  let chunks = 0;
  let backfilled = false;

  try {
    await client.query(readFileSync(bootstrapPath, "utf8"));
    await ensureMigrationJournal(client);

    const { rows: journalRows } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "growthos"."__drizzle_migrations"`,
    );

    if (journalRows[0]?.count === "0" && (await coreTablesExist(client))) {
      await backfillJournal(client, migrations);
      backfilled = true;
    }

    const { rows } = await client.query<{ created_at: string | null }>(
      `
        SELECT created_at::text
        FROM "growthos"."__drizzle_migrations"
        ORDER BY created_at DESC
        LIMIT 1
      `,
    );
    const lastAppliedAt = Number(rows[0]?.created_at ?? 0);

    for (const migration of migrations) {
      if (migration.when <= lastAppliedAt) continue;
      chunks += await applyMigration(client, migration);
      applied += 1;
    }

    for (const table of CORE_TABLES) {
      const { rows: tableRows } = await client.query<{ ok: boolean }>(
        `SELECT to_regclass('growthos.' || $1::text) IS NOT NULL AS ok`,
        [table],
      );
      if (!tableRows[0]?.ok) {
        throw new Error(
          `Expected table growthos.${table} to exist after migration.`,
        );
      }
    }
  } finally {
    await client.end();
  }

  console.log(
    `migrate-local: ok (${applied} applied, ${chunks} chunks, ${
      backfilled ? "journal backfilled" : "journal current"
    }).`,
  );
}

main().catch((err: unknown) => {
  console.error("migrate-local:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
