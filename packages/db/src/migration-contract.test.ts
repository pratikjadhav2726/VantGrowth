import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationPath = new URL(
  "../migrations/0001_growthos_core.sql",
  import.meta.url,
);

describe("growthos core migration", () => {
  it("enables and forces RLS on tenant-scoped tables", async () => {
    const sql = await readFile(migrationPath, "utf8");
    const tables = [
      "motion_scores",
      "motion_stack",
      "approval_feedback",
      "event_outbox",
    ];

    for (const table of tables) {
      expect(sql).toContain(
        `ALTER TABLE growthos.${table} ENABLE ROW LEVEL SECURITY;`,
      );
      expect(sql).toContain(
        `ALTER TABLE growthos.${table} FORCE ROW LEVEL SECURITY;`,
      );
      expect(sql).toContain(`CREATE POLICY ${table}_tenant_isolation`);
    }
  });

  it("enforces event outbox idempotency structurally", async () => {
    const sql = await readFile(migrationPath, "utf8");

    expect(sql).toContain("idempotency_key TEXT NOT NULL");
    expect(sql).toContain("UNIQUE (tenant_id, event_type, idempotency_key)");
  });
});
