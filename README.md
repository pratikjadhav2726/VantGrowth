# GrowthOS v4

Phase-0 monorepo scaffold for GrowthOS domain implementation.

## Quick start

```bash
pnpm install
pnpm dev
```

API service defaults to `http://localhost:3001`.

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
- `packages/db`: database contracts, core migration baseline, tenant helpers, outbox repository.
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
- `apps/infra-smoke`: opt-in live Postgres/NATS smoke check.
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

After applying `packages/db/migrations/0001_growthos_core.sql` to Postgres and creating a JetStream stream that accepts `growthos.*.infra_smoke.v1`, run:

```bash
DATABASE_URL=postgres://... NATS_SERVERS=nats://localhost:4222 pnpm smoke:infra
```

## First implemented endpoints

- `GET /health`
- `POST /v1/motions/score`
- `POST /v1/commands/outbox`
- `POST /v1/workflows/hello`
- `POST /v1/workflows/tenant-provisioning`
- `POST /v1/workflows/runtime-callbacks/tenant-provisioning`
  (supports optional signature verification via `RESTATE_CALLBACK_SECRET`).

## Architecture references

- `Growthos_v4.md`
- `Growthos_v4_Technical_Architecture.md`
- `Growthos_v4_Stack_Decisions.md`
- `Growthos_v4_Implementation_Plan.md`
- `FORKING_PLAN.md`
