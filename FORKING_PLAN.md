# GrowthOS v4 Forking + Local Implementation Plan

This repository is now the GrowthOS domain monorepo scaffold.  
Use the following fork strategy so control-plane and runtime responsibilities stay clean.

## 1) Fork now (required)

1. **Paperclip** (control plane fork)
   - Why: companies, agents, issues, approvals, routines, heartbeat-runs, adapter model.
   - Branch convention: `growthos/main`, `growthos/upstream-sync`, feature branches `growthos/<delta-name>`.
   - First deltas to implement in fork:
     - RLS on all tenant-scoped tables.
     - Distributed scheduler migration.
     - Live events fan-out hardening.
     - `growthos_native` adapter registration.

2. **SmarterMCP** (deploy/configure, fork only if custom patches needed)
   - Why: governed MCP tool runtime, tool entitlements, DLP, response caching, proxy exploration.
   - Start with deployment + configuration before code patching.

## 1.1) Local workspace setup (now that fork is present)

- Paperclip fork path (local): `../paperclip` from this repo root.
- Keep repos separate (no git submodule required at this stage).
- Recommended branch defaults in the Paperclip fork:
  - `growthos/main` (integration branch for GrowthOS deltas)
  - `growthos/upstream-sync` (weekly merge from upstream)

### Local integration contract

- GrowthOS domain code (this repo) calls Paperclip over HTTP/MCP only.
- Do not import Paperclip source files directly into this monorepo.
- Share identifiers through contracts:
  - `tenant_id` in GrowthOS == `company.id` in Paperclip
  - `run_id` correlation propagated across API, workers, SmarterMCP, and Paperclip

## 2) Keep in this repo (do not put in Paperclip fork)

- Motion Engine
- Signal Router
- Confidence Scorer
- Learning Director pipeline
- Experiment framework
- Warmth + GEO domain services
- Skills resolver + handoff contracts + schemas
- Founder-facing product surfaces

## 3) Immediate next coding steps in this repo

1. Implement `growthos` schema migrations (`motion_scores`, `motion_stack`, `signals`, `approval_feedback`, `event_outbox`).
2. Add persistence adapters for:
   - Postgres (Drizzle)
   - NATS JetStream or Redis stream bridge
3. Build `worker-signal-router` and `worker-critique` as first async workers.
4. Add contract test suite for:
   - handoff schemas
   - event schemas
   - idempotency key behavior
5. Add CI quality gates: lint, typecheck, unit tests, schema compatibility checks.

## 4) Repository boundaries

- `apps/api`: sync boundary (validate request, emit command, return 202).
- `packages/core`: domain contracts, scoring logic, event command schemas.
- `packages/adapter`: integration ports and adapter-side contracts.
- `packages/skills`: runtime parsing/loading for skill manifests and bodies.
- `packages/design-system`: UI design tokens/primitives starter.
- `packages/test-utils`: shared test fixtures and helpers.

## 5) First integration tasks with local Paperclip fork

1. Add environment variables in GrowthOS for Paperclip base URL + service token.
2. Implement Paperclip client port in `packages/adapter`:
   - create company
   - create/wakeup agent
   - create/update issue
   - checkout/release issue
   - status: implemented as typed `PaperclipClient` in `packages/adapter`
3. Add contract tests for Paperclip API payload schemas in this repo.
4. Keep fork-specific DB/migration changes inside `../paperclip`.
