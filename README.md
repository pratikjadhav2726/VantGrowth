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
- `apps/infra-smoke`: opt-in live Postgres/NATS smoke check.

## Live infrastructure smoke

After applying `packages/db/migrations/0001_growthos_core.sql` to Postgres and creating a JetStream stream that accepts `growthos.*.infra_smoke.v1`, run:

```bash
DATABASE_URL=postgres://... NATS_SERVERS=nats://localhost:4222 pnpm smoke:infra
```

## First implemented endpoints

- `GET /health`
- `POST /v1/motions/score`
- `POST /v1/commands/outbox`

## Architecture references

- `Growthos_v4.md`
- `Growthos_v4_Technical_Architecture.md`
- `Growthos_v4_Stack_Decisions.md`
- `Growthos_v4_Implementation_Plan.md`
- `FORKING_PLAN.md`
