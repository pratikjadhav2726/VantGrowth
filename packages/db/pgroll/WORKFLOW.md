# pgroll Expand–Contract Workflow

Zero-downtime schema changes for GrowthOS using [pgroll](https://github.com/xataio/pgroll).

---

## When to use pgroll vs plain Drizzle

| Change type | Tool | Reason |
|---|---|---|
| Add nullable column | Drizzle + `migrate:apply` | Non-breaking; all existing rows accept NULL |
| Add new table | Drizzle + `migrate:apply` | Additive; no live code reads it yet |
| Create index (non-unique) | Drizzle + `migrate:apply` | `CREATE INDEX CONCURRENTLY` is non-blocking |
| Rename column | **pgroll expand→contract** | Old code breaks the moment the column is gone |
| Drop column | **pgroll expand→contract** | Same — old pods reference the column |
| Change column type (breaking) | **pgroll expand→contract** | e.g., `text` → `uuid`; SELECT cast fails on old code |
| Rename table | **pgroll expand→contract** | All queries referencing the old name break |

**Rule of thumb:** if old application code would raise a Postgres error after the migration, use pgroll. Otherwise, plain Drizzle apply is fine.

---

## The three-phase lifecycle

```
┌─────────────┐     pnpm migrate:expand     ┌─────────────────────────────────┐
│  schema v1  │ ──────────────────────────► │  schema v1 + v2 (both visible)  │
└─────────────┘                             └─────────────────────────────────┘
                                                         │
                                          Deploy new pods (v2 code)
                                          Old pods still serving (v1 code)
                                                         │
                                                         ▼
                                            pnpm migrate:contract
                                            (after all old pods drained)
                                            ┌─────────────┐
                                            │  schema v2  │
                                            └─────────────┘
```

During the expand phase pgroll materialises **database views** that present the schema under both old and new names simultaneously. Old pods read/write v1 columns; new pods read/write v2 columns. No locks, no downtime.

---

## Quick reference

```bash
# 1. Expand — starts the migration, creates dual-version views
PGROLL_MIGRATION_FILE=packages/db/pgroll/migrations/<file>.yaml \
  DATABASE_URL=postgresql://... \
  pnpm migrate:expand

# 2. Check state — see active migration and version history
DATABASE_URL=postgresql://... pnpm migrate:status

# 3. If expand looks wrong — roll it back (removes views, restores v1 schema)
DATABASE_URL=postgresql://... pnpm migrate:rollback

# 4. Contract — complete the migration, drop v1 artefacts
DATABASE_URL=postgresql://... pnpm migrate:contract
```

All commands delegate to the `pgroll` CLI with `--schema growthos` so the GrowthOS Postgres schema is targeted (not `public`).

---

## Step-by-step procedure

### Step 1 – Write the migration file

Create `packages/db/pgroll/migrations/NNN_<description>.yaml`. See `migrations/` for examples.

### Step 2 – Expand (before deploying new code)

```bash
export DATABASE_URL=postgresql://postgres:postgres@localhost:5488/growthos_ci

PGROLL_MIGRATION_FILE=packages/db/pgroll/migrations/NNN_example.yaml \
  pnpm migrate:expand
```

pgroll writes its state to the `pgroll` Postgres schema. Both the old and new column/table names are now visible in the database.

### Step 3 – Verify dual-version schema

```bash
pnpm migrate:status
# Should show: active migration = NNN_example | versions = v1, v2
```

```sql
-- Connect to Postgres and verify both views exist
\dv growthos.*
```

### Step 4 – Deploy application code

Deploy the new version of the application pods (or restart the local dev server). The new code uses the **new** column/table names. Old pods continue to function via the v1 view.

### Step 5 – Contract (after all old pods are drained)

Once no old-version pods are running:

```bash
DATABASE_URL=postgresql://... pnpm migrate:contract
```

pgroll drops the v1 view artefacts and makes the v2 schema permanent.

### Step 6 – Sync Drizzle schema

After contracting, update `packages/db/src/schema.ts` to reflect the new final state and regenerate:

```bash
# Regenerate Drizzle migration to capture any pgroll-applied DDL that Drizzle
# doesn't know about. Review the generated SQL before committing.
pnpm --filter @growthos/db db:generate

# Refresh Atlas checksums
pnpm --filter @growthos/db db:atlas-hash

# Commit: schema.ts + drizzle/<new-migration>.sql + drizzle/atlas.sum
```

---

## Example 1 – Adding a column with a backfill

`packages/db/pgroll/migrations/001_add_quality_score_to_motion_scores.yaml`

This is the simplest pgroll case: adding a non-nullable column that requires a default backfill on existing rows.

```yaml
name: 001_add_quality_score_to_motion_scores
operations:
  - add_column:
      table: motion_scores
      column:
        name: quality_score
        type: numeric(4, 3)
        nullable: false
        default: "0.500"
      up: "0.500"     # SQL expression to compute value for existing rows
      down: null      # rollback: DROP the column (nullable during rollback)
```

Note: the `up` expression is executed as a Postgres expression for each existing row. It can reference other columns: `up: "CASE WHEN scores IS NULL THEN 0.5 ELSE 0.75 END"`.

## Example 2 – Renaming a column (zero-downtime)

`packages/db/pgroll/migrations/002_rename_motion_scores_rationale.yaml`

Renaming `rationale` → `scorer_rationale` without breaking old code that still reads `rationale`.

```yaml
name: 002_rename_rationale_to_scorer_rationale
operations:
  - rename_column:
      table: motion_scores
      from: rationale
      to: scorer_rationale
```

During the expand phase, pgroll creates a view in the `growthos_<migration-name>` schema where `scorer_rationale` resolves to the physical column, and `growthos` (the current search path) continues exposing `rationale` via the v1 view. Both names work simultaneously.

After contracting: the physical column is `scorer_rationale`. The v1 `rationale` view is dropped.

**Drizzle schema update (post-contract):**

```typescript
// packages/db/src/schema.ts — rename the column
scorerRationale: text("scorer_rationale").array().notNull().default(sql`'{}'::text[]`),
```

Then: `pnpm --filter @growthos/db db:generate && pnpm --filter @growthos/db db:atlas-hash`.

---

## CI considerations

pgroll expand/contract is a **production deployment operation**, not a CI step. CI runs:
- `migrate:dry-run` — applies the Drizzle migration to a throwaway DB (validates DDL)
- `atlas migrate validate/lint` — validates checksums and detects destructive changes

The pgroll state is **not** tracked in CI. It is tracked in the live Postgres `pgroll` schema.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `pgroll: relation "pgroll.migrations" does not exist` | pgroll not yet initialised on this DB | `pgroll init --postgres-url "$DATABASE_URL"` then retry |
| `ERROR: column "x" of relation "y" does not exist` in old code after expand | Old code references a column that pgroll has already renamed/dropped | Roll back (`migrate:rollback`) and check deploy sequence |
| `pgroll complete` fails with "no active migration" | Contract already ran or expand never ran | `pnpm migrate:status` to inspect state |
| Drizzle schema drifts from physical schema after pgroll | Drizzle `schema.ts` not updated post-contract | Run `db:generate`, review diff, commit |

---

## Installing pgroll CLI

pgroll is an external binary — install it once per developer workstation and in CI when needed:

```bash
# macOS (Homebrew)
brew install xataio/tap/pgroll

# Linux (binary)
curl -sL https://github.com/xataio/pgroll/releases/latest/download/pgroll_linux_amd64.tar.gz | tar xz
sudo mv pgroll /usr/local/bin/

# Verify
pgroll --version
```

pgroll is **not** installed as a project npm dependency. Like Atlas, it is an infrastructure CLI tool managed separately.
