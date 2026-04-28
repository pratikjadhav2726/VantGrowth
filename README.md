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
4. **Postgres migration dry-run** — ephemeral Postgres 16; runs `pnpm --filter @growthos/db migrate:dry-run` (bootstrap + Drizzle migration + table checks; same as `pnpm migrate:dry-run` from the repo root).

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
- `packages/db`: Drizzle ORM schema (`src/schema.ts`), drizzle-kit migrations (`drizzle/`), `pnpm migrate:dry-run` (bootstrap + apply + table checks, same as CI), typed Postgres repositories, tenant helpers, outbox + workflow run repositories.
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
- `apps/infra-smoke`: opt-in live Postgres + NATS JetStream smoke check; optional Restate tenant-provisioning **runtime state** contract verification.
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

1. Apply Drizzle migrations to Postgres (from `packages/db`):

   ```bash
   pnpm --filter @growthos/db db:generate   # when schema changes
   pnpm --filter @growthos/db db:migrate   # apply migrations (requires DATABASE_URL)
   ```

   Migration SQL lives under `packages/db/drizzle/` (e.g. `0000_yielding_inertia.sql`). If you apply SQL with `psql -f` instead of `drizzle-kit migrate`, run `packages/db/ci/bootstrap.sql` first so `growthos` and `pgcrypto` exist (CI uses the same order).

2. Create a JetStream stream that accepts subjects matching `growthos.*.infra_smoke.v1` (the smoke publisher uses `growthos.<tenant_uuid>.infra_smoke.v1`).

3. Run smoke:

   ```bash
   DATABASE_URL=postgres://... NATS_SERVERS=nats://localhost:4222 pnpm smoke:infra
   ```

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
