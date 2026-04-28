# GrowthOS v4

Phase-0 monorepo scaffold for GrowthOS domain implementation.

## Quick start

```bash
pnpm install
pnpm dev
```

API service defaults to `http://localhost:3001`.

## CI (GitHub Actions)

On push and pull request to `main` / `master`, [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs:

1. **`pnpm check`** — Biome lint/format (same as local `pnpm check`).
2. **`pnpm typecheck`** — TypeScript across the Turborepo graph.
3. **`pnpm test`** — Vitest via Turbo.
4. **Postgres migration dry-run + Atlas** — ephemeral Postgres 16: runs `pnpm --filter @growthos/db migrate:dry-run`, then **`atlas migrate validate`** (checksums vs `drizzle/atlas.sum`) and **`atlas migrate lint --latest 1`** against a scratch database `atlas_lint` (destructive-change policy from `packages/db/atlas.hcl`). Same dry-run locally: `pnpm migrate:dry-run`. Atlas CLI parity: `pnpm atlas:validate` and `pnpm atlas:lint` (see [Atlas](https://atlasgo.io/getting-started#installation); lint needs `ATLAS_LINT_DEV_URL` or Docker for the default dev URL).

For a full local stack (Postgres + NATS + `GROWTHOS` stream), see **Local infra (Docker Compose)** below.

For parity with CI before you push:

```bash
pnpm check && pnpm typecheck && pnpm test
```

### Migration dry-run (Postgres)

Uses the same path as CI: `packages/db/ci/bootstrap.sql` plus `packages/db/drizzle/0000_yielding_inertia.sql`, executed statement-by-statement via `pg` (splits on Drizzle `--> statement-breakpoint` markers).

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/growthos_ci pnpm migrate:dry-run
```

Optional overrides: `GROWTHOS_MIGRATE_BOOTSTRAP_SQL`, `GROWTHOS_MIGRATE_SQL` (absolute paths to alternate SQL files).

### Atlas (migration directory integrity + lint)

[`packages/db/atlas.hcl`](packages/db/atlas.hcl) pins the Drizzle migration directory for [Atlas](https://atlasgo.io/) **checksum validation** and **migration lint** (e.g. destructive DDL fails CI when `lint.destructive.error` is set). After you add or edit `packages/db/drizzle/*.sql`, refresh checksums:

```bash
pnpm --filter @growthos/db db:atlas-hash
```

Then commit the updated `packages/db/drizzle/atlas.sum`. Validate locally (Atlas on `PATH`):

```bash
pnpm atlas:validate
```

Lint the latest migration against a **throwaway Postgres** (recommended: empty DB you create once):

```bash
export ATLAS_LINT_DEV_URL='postgresql://postgres:postgres@127.0.0.1:5488/atlas_lint?sslmode=disable'
pnpm atlas:lint
```

If `ATLAS_LINT_DEV_URL` is unset, `db:atlas-lint` defaults to `docker://postgres/16/dev?search_path=public` (requires Docker).

### Local infra (Docker Compose)

[`compose.yaml`](compose.yaml) starts the full Phase-0 data and event plane on non-default host ports (no collision with local services):

| Service | Purpose | Host port(s) |
|---|---|---|
| `postgres` | Postgres 16 | **5488** |
| `nats` + `jetstream-init` | NATS JetStream + `GROWTHOS` stream | **4228** (client) / **8228** (monitor) |
| `valkey` | Valkey 8 (Redis-compatible cache) | **6388** |
| `minio` + `minio-init` | MinIO S3-compatible store (buckets: `growthos`, `growthos-assets`) | **9088** (S3 API) / **9089** (console) |
| `clickhouse` | ClickHouse 24 (analytics: `growthos` DB auto-created) | **8124** (HTTP) / **9010** (native) |
| `meilisearch` | Meilisearch v1.11 (full-text / vector search) | **7701** |

```bash
pnpm infra:up          # docker compose up -d
pnpm infra:ps          # container status
pnpm infra:down        # stop and remove volumes (wipes all data)
```

After `infra:up` is healthy, apply migrations + seed a dev tenant:

```bash
export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5488/growthos_ci

# Apply bootstrap SQL + Drizzle migration (same path as CI)
pnpm migrate:dry-run

# OR use Atlas for an explicit apply (requires Atlas CLI on PATH):
pnpm migrate:apply

# Seed well-known dev tenant (idempotent)
NATS_SERVERS=nats://127.0.0.1:4228 pnpm seed:dev

# Verify outbox drain + JetStream publish
NATS_SERVERS=nats://127.0.0.1:4228 pnpm smoke:infra
```

Env overrides for `seed:dev`:

| Var | Default | Description |
|---|---|---|
| `DATABASE_URL` | required | Postgres connection string |
| `GROWTHOS_DEV_TENANT_ID` | `00000000-0000-0000-0001-000000000001` | Well-known dev tenant UUID |
| `NATS_SERVERS` | _(unset — Postgres only)_ | Publish seed event to JetStream |

If a service exits non-zero, inspect logs: `docker compose -f compose.yaml logs <service>`.

## Local multi-repo setup

- GrowthOS repo: current directory
- Paperclip fork repo: `../paperclip`

Run both in parallel during integration:

```bash
# Terminal 1 (Paperclip)
cd ../paperclip
pnpm install
pnpm dev

# Terminal 2 (GrowthOS)
cd ../GTM
pnpm install
pnpm dev
```

## Current modules

- `apps/api`: Hono API with async command acceptance pattern.
- `packages/core`: domain schemas + deterministic motion scoring.
- `packages/db`: Drizzle ORM schema (`src/schema.ts`), drizzle-kit migrations (`drizzle/` + **`atlas.sum`** / **`atlas.hcl`** for Atlas validate + lint), `pnpm migrate:dry-run` (bootstrap + apply + table checks, same as CI), `pnpm atlas:validate` / `pnpm atlas:lint`, typed Postgres repositories, tenant helpers, outbox + workflow run repositories.
- `packages/adapter`: `growthos_native` adapter contract starter.
- `packages/skills`: skill frontmatter/body parser + loader.
- `packages/design-system`: initial token set.
- `packages/test-utils`: shared fixtures.
- `apps/worker-signal-router`: Signal Router worker with Postgres outbox + NATS JetStream publisher.
- `apps/worker-critique`: Critique worker starter with idempotent outbox + tenant-scoped publish contract.
- `apps/worker-outbox-publisher`: Poll-based outbox publisher worker that emits unconsumed tenant events to NATS JetStream and marks them consumed.
- `apps/worker-learning`: Learning worker starter that synthesizes learning candidates from approval feedback and emits tenant-scoped events.
- `apps/worker-attribution`: Attribution worker starter that computes touchpoint rollups and emits tenant-scoped attribution rollup events.
- `apps/worker-warmth`: Warmth worker starter that evaluates warmth threshold gating and emits tenant-scoped warmth evaluation events.
- `apps/worker-workflow-callback`: Workflow callback worker starter that emits tenant provisioning completion events from accepted workflow requests.
- `apps/infra-smoke`: opt-in live Postgres + NATS JetStream smoke; drains outbox via **`@growthos/worker-outbox-publisher`** (same publish path as the worker), then verifies JetStream `last_by_subj` read-back; optional Restate tenant-provisioning **runtime state** contract verification.
- `@growthos/core` now includes a Restate workflow starter contract module for `workflow.hello.requested.v1`.
  and tenant provisioning `workflow.tenant_provisioning.requested.v1`.
  It now also includes a typed Restate HTTP client boundary (`RESTATE_BASE_URL`, optional `RESTATE_API_KEY`).

`apps/worker-outbox-publisher` runtime env:
- `OUTBOX_TENANT_IDS` (required, comma-separated UUID list)
- `OUTBOX_BATCH_SIZE_PER_TENANT` (optional, default `100`)
- `OUTBOX_POLL_INTERVAL_MS` (optional, default `1000`)
- `OUTBOX_LEASE_ADVISORY_LOCK_KEY` (optional, default `1104021`)
- `OUTBOX_ENABLE_LISTEN_NOTIFY` (optional, set `false` to disable Postgres wakeups)

## Live infrastructure smoke

1. Apply Drizzle migrations to Postgres.  Two supported paths:

   **Option A — `migrate:dry-run`** (used in CI and local dev):
   ```bash
   DATABASE_URL=... pnpm migrate:dry-run
   ```

   **Option B — `atlas migrate apply`** (production apply, requires Atlas on `PATH`):
   ```bash
   DATABASE_URL=... pnpm migrate:apply
   ```

   Migration SQL lives under `packages/db/drizzle/`. If you apply with `psql -f` directly, run `packages/db/ci/bootstrap.sql` first (`growthos` schema + `pgcrypto`).

2. Seed a dev tenant (idempotent):

   ```bash
   DATABASE_URL=... [NATS_SERVERS=...] pnpm seed:dev
   ```

3. Ensure a JetStream stream accepts **worker-style** subjects (`t.<tenant_uuid>.growthos.infra_smoke.v1`, from `tenantScopedSubject`). Either use **`pnpm infra:up`** (creates stream **`GROWTHOS`** with `t.>`) or configure your broker manually with a filter such as `t.>`.

4. Run smoke:

   ```bash
   DATABASE_URL=postgres://... NATS_SERVERS=nats://localhost:4222 pnpm smoke:infra
   ```

   Optional: `GROWTHOS_JETSTREAM_STREAM` (default `GROWTHOS`) — stream name used when reading back the last message for the drain subject.

   Smoke verifies in one run:
   - Postgres outbox enqueue succeeds
   - **`OutboxPublisher` + `NatsJetStreamPublisher`** drain the row (same code path as the worker), marking it consumed
   - JetStream stores the payload; smoke reads it back with `last_by_subj` on the drain subject and checks `smokeId` + `source`

### Optional: Restate runtime state contract

When your Restate gateway (or adapter) exposes the GrowthOS contract:

`GET {RESTATE_BASE_URL}/workflows/tenant-provisioning/:workflowId/state?tenantId=<uuid>`

…returning JSON that matches `tenantProvisioningRuntimeStateSchema` in `@growthos/core`, you can extend smoke to validate it end-to-end:

```bash
DATABASE_URL=postgres://... \
NATS_SERVERS=nats://localhost:4222 \
RESTATE_BASE_URL=http://localhost:8080 \
GROWTHOS_SMOKE_WORKFLOW_ID=wf-smoke-1 \
pnpm smoke:infra
```

`RESTATE_BASE_URL` and `GROWTHOS_SMOKE_WORKFLOW_ID` must be set **together** (validated by `apps/infra-smoke`).

## First implemented endpoints

- `GET /health`
- `POST /v1/motions/score`
- `POST /v1/commands/outbox`
- `POST /v1/workflows/hello`
- `POST /v1/workflows/tenant-provisioning`
- `POST /v1/workflows/runtime-callbacks/tenant-provisioning`
  (supports optional signature verification via `RESTATE_CALLBACK_SECRET`).

**Restate integration note:** the typed HTTP client in `@growthos/core` includes `getTenantProvisioningRuntimeState` for the state endpoint above; align your Restate ingress or sidecar with that path and response shape for workers and smoke checks.

## Architecture references

- `Growthos_v4.md`
- `Growthos_v4_Technical_Architecture.md`
- `Growthos_v4_Stack_Decisions.md`
- `Growthos_v4_Implementation_Plan.md`
- `FORKING_PLAN.md`
