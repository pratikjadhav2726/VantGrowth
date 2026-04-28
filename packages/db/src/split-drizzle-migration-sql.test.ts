import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { splitDrizzleMigrationSql } from "./split-drizzle-migration-sql.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("splitDrizzleMigrationSql", () => {
  it("splits the bundled 0000 migration into non-empty statements", () => {
    const sqlPath = path.join(
      __dirname,
      "../drizzle/0000_yielding_inertia.sql",
    );
    const sql = readFileSync(sqlPath, "utf8");
    const chunks = splitDrizzleMigrationSql(sql);
    expect(chunks.length).toBeGreaterThanOrEqual(10);
    expect(
      chunks.some((c) => c.includes('CREATE TABLE "growthos"."workflow_runs"')),
    ).toBe(true);
    expect(
      chunks.some((c) =>
        c.includes(
          'ALTER TABLE "growthos"."motion_stack" ADD CONSTRAINT "motion_stack_source_score_id_motion_scores_id_fk"',
        ),
      ),
    ).toBe(true);
  });

  it("handles breakpoint on same line as statement terminator", () => {
    const sql = `SELECT 1;
--> statement-breakpoint
SELECT 2;--> statement-breakpoint
SELECT 3`;
    const chunks = splitDrizzleMigrationSql(sql);
    expect(chunks).toEqual(["SELECT 1;", "SELECT 2;", "SELECT 3"]);
  });
});
