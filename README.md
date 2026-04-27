# GrowthOS v4

Phase-0 monorepo scaffold for GrowthOS domain implementation.

## Quick start

```bash
pnpm install
pnpm dev
```

API service defaults to `http://localhost:3001`.

## Current modules

- `apps/api`: Hono API with async command acceptance pattern.
- `packages/core`: domain schemas + deterministic motion scoring.
- `packages/adapter`: `growthos_native` adapter contract starter.
- `packages/skills`: skill frontmatter/body parser + loader.
- `packages/design-system`: initial token set.
- `packages/test-utils`: shared fixtures.

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
