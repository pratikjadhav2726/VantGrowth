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

### Zero-downtime schema changes (pgroll expand–contract)

For **breaking changes** (rename/drop column, change column type) that would break old running pods, use [pgroll](https://github.com/xataio/pgroll) instead of a plain Drizzle apply. See [`packages/db/pgroll/WORKFLOW.md`](packages/db/pgroll/WORKFLOW.md) for the full guide. Short version:

```bash
# 1. Expand — add new schema alongside old (both visible simultaneously)
PGROLL_MIGRATION_FILE=packages/db/pgroll/migrations/<file>.yaml \
  DATABASE_URL=postgresql://... \
  pnpm migrate:expand

# 2. Check state
DATABASE_URL=postgresql://... pnpm migrate:status

# 3. Deploy new code, drain old pods, then contract
DATABASE_URL=postgresql://... pnpm migrate:contract

# 4. Roll back if something is wrong before contracting
DATABASE_URL=postgresql://... pnpm migrate:rollback
```

For **additive changes** (new nullable column, new table), plain `pnpm migrate:apply` is fine.

See [`packages/db/pgroll/migrations/`](packages/db/pgroll/migrations/) for annotated examples.

### RLS invariant tests

The generated RLS test suite (`packages/db/src/rls-invariants.test.ts`) verifies all 5 tenant-scoped tables for owner-reads / cross-tenant-blocked / no-context-blocked invariants. It runs automatically in CI in the dedicated `rls-invariants` job. To run locally:

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5488/growthos_ci pnpm --filter @growthos/db test
```

Tests are skipped when `DATABASE_URL` is unset (unit-test mode).

### Local infra (Docker Compose)

[`compose.yaml`](compose.yaml) starts the full Phase-0 data and event plane on non-default host ports (no collision with local services):

| Service | Purpose | Host port(s) |
|---|---|---|
| `postgres` | Postgres 16 | **5488** |
| `nats` + `jetstream-init` | NATS JetStream + `GROWTHOS` stream | **4228** (client) / **8228** (monitor) |
| `valkey` | Valkey 8 (Redis-compatible cache) | **6388** |
| `minio` + `minio-init` | MinIO S3-compatible store (buckets: `growthos`, `growthos-assets`) | **9088** (S3 API) / **9089** (console) |
| `clickhouse` | ClickHouse 24 (analytics: `growthos` DB auto-created) | **8124** (HTTP) / **9010** (native) |
| `qdrant` | Qdrant v1.12 (vector store — memory + embeddings) | **6343** (HTTP) / **6344** (gRPC) |
| `gitea` | Gitea v1.22 (per-tenant workspace repos, SQLite dev mode) | **3088** (HTTP) / **2222** (SSH) |
| `meilisearch` | Meilisearch v1.11 (full-text / vector search) | **7701** |
| `openbao` | OpenBao 2.2 (Vault-compatible secrets + KMS envelope encryption) | **8200** |

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

OpenBao dev mode token: `growthos-dev-root-token`. Vault-compatible API: `http://localhost:8200`.

```bash
# Quick secret write/read verification (requires vault CLI or curl)
curl -s -H "X-Vault-Token: growthos-dev-root-token" \
  http://localhost:8200/v1/sys/health | jq .initialized
```

If a service exits non-zero, inspect logs: `docker compose -f compose.yaml logs <service>`.

### Operational runbooks

See [`docs/runbooks/`](docs/runbooks/) for incident response procedures:

| Runbook | When to use |
|---|---|
| [`nats-leader-loss.md`](docs/runbooks/nats-leader-loss.md) | Outbox publisher stalls; JetStream meta-leader empty |
| [`postgres-failover.md`](docs/runbooks/postgres-failover.md) | All writes failing; `pg_is_in_recovery()` = true on primary |
| [`openbao-seal-unseal.md`](docs/runbooks/openbao-seal-unseal.md) | Secrets unavailable; `/v1/sys/health` returns `sealed: true` |

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

- `packages/observability`: `@growthos/observability` — OpenTelemetry + pino logging scaffolding. Exports `getTracer()`, `getMeter()`, `createStandardMetrics()`, `createLogger()`, `initOtelSdk()`, `createHttpMiddleware()`, plus re-exports `SpanKind`, `SpanStatusCode`, `context`, `trace` from `@opentelemetry/api` so consumers need no direct OTel dep. SDK init is no-op when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset. See **Observability** section below.
- `apps/api`: Hono API with async command acceptance pattern. Mounts OTel middleware (`createHttpMiddleware`) on every route; SDK initialised at startup via `initOtelSdk("growthos.api")`; structured pino logger replaces all `console.*` calls. Routes: `POST /v1/motions/score`, `POST /v1/commands/outbox`, `POST /v1/workflows/*`, **`POST /v1/signals`** (signal ingest → `SignalEventsRepository`, idempotent, `X-Tenant-Id` header), **`GET /v1/approvals`** (pending outbox events filtered by `outputType`), **`POST /v1/approvals/decide`** (records approve/reject/edit decision via `ApprovalFeedbackRepository`). 34 unit tests.
- `apps/web`: **`@growthos/web`** — Phase 1 / S5 UI starter. Next.js 15 App Router, Tailwind CSS 3, Inter font. **Approval Queue** page (`/approvals`): server-fetched pending items, per-draft Approve/Reject via Server Actions with reviewer note field, quality indicator chips (CTA, internal links, heading count), status badges; **Motion Stack** page (`/motion`): motion score grid with score bars + active/secondary/observe badges, scorer metadata, input summary panel; **Signal Ingest** page (`/signals`): client-side form for all 6 signal types with source/externalId/note, idempotent dedup feedback. Typed `ApiClient` (`src/lib/api-client.ts`) with Zod-validated responses for all 3 endpoints. Runs on port 3088 (`pnpm dev` / `pnpm start`).
- `packages/core`: domain schemas + deterministic motion scoring + **handoff contracts v0** (`intel_brief.v1`, `content_opportunity.v1`, `content_brief.v1`, `blog_draft.v1` Zod schemas with registry + dispatcher) + **`TenantProvisioningOrchestrator`** (5-step idempotent provisioning: Paperclip company → Gitea workspace repo → NATS consumer group → MinIO bucket → seed `FOUNDER.md`) with typed client interfaces and stub implementations. **Real HTTP provisioning clients**: `HttpGiteaProvisioningClient` (Gitea v1 REST API via native `fetch`, idempotent repo generation + file upsert) and `HttpMinioProvisioningClient` (`@aws-sdk/client-s3` with MinIO S3-compatible endpoint, path-style addressing, idempotent bucket creation). Both expose `fromEnv()` factories and are selected via `ENABLE_REAL_GITEA_CLIENT` / `ENABLE_REAL_MINIO_CLIENT` env flags in `worker-workflow-callback`.
- `packages/db`: Drizzle ORM schema (`src/schema.ts`), drizzle-kit migrations (`drizzle/` + **`atlas.sum`** / **`atlas.hcl`** for Atlas validate + lint), `pnpm migrate:dry-run` (bootstrap + apply ALL `drizzle/*.sql` in lexicographic order + 7-table check, same as CI), `pnpm atlas:validate` / `pnpm atlas:lint`, typed Postgres repositories. **7 tenant-scoped tables**: `motion_scores`, `motion_stack`, `approval_feedback`, `event_outbox`, `workflow_runs`, `playbook_versions` (Critique rubrics, versioned + soft-retirable), `signal_events` (high-volume write path, partial-unique dedup by externalId). Repositories: `OutboxRepository`, `WorkflowRunRepository`, **`PlaybookVersionsRepository`** (getActive/listAll/create/retire), **`SignalEventsRepository`** (ingest/listUnprocessed/markProcessed), **`ApprovalFeedbackRepository`** (record/listRecent — founder approve/reject decisions; `InMemoryApprovalFeedbackRepository` + `PostgresApprovalFeedbackRepository`). Includes **generated RLS invariant tests** — all 7 tables covered (21 cases); skipped unless `DATABASE_URL` is set. **`seed-dev-cli`** now seeds `blog_draft` + `content_brief` rubric playbooks for local dev end-to-end testing.
- `packages/llm-harness`: **`@growthos/llm-harness`** — Phase 0 / Track D LLM abstraction layer. `PromptTemplate<TVars>` type + `definePrompt()` factory (validates id format + semver version); `LlmCallRunner` interface + `LlmCallRunOptions` + `LlmCallResult`; **`StubLlmCallRunner`** (deterministic test double: per-template string or factory responses, call history inspection, `callsFor()`, `reset()`); **`OpenAiLlmCallRunner`** (production: automatic retry with exponential backoff on 429/5xx, OTel `llm.chat.completions` span with model/tokens/latency/cost/cache attrs, static per-model cost table + `registerModelPricing()`, prompt-cache detection, `fromEnv()` factory, optional `logSink` for cost observability); 4 built-in versioned prompt templates for all current workers; 40 unit tests. **`LlmCallLogSink`** observability pipeline: `NoopLlmCallLogSink` (test/dev), `ClickHouseLlmCallLogSink` (HTTP `JSONEachRow` insert to `growthos.llm_call_logs`, error-resilient), `BufferedLlmCallLogSink` (in-memory ring buffer with `maxBatchSize` + auto-flush timer, prefers `insertRows()` batch method). `llm_call_logs` ClickHouse DDL in `001_init.sql` (24-month TTL, partitioned by month).
- `packages/adapter`: `growthos_native` adapter contract starter.
- `packages/skills`: skill frontmatter/body parser + loader. **Skills library v0** at `packages/skills/library/`: `base/founder_voice.md`, `base/brand_rules.md`, `base/claims_handling.md`, `inbound/content_strategist.md`, `intel/intel_director.md` — each with validated YAML frontmatter and production-quality agent instructions.
- `packages/design-system`: initial token set.
- `packages/test-utils`: shared fixtures.
- `apps/worker-signal-router`: Signal Router worker with Postgres outbox + NATS JetStream publisher. OTel SDK + pino logger wired.
- `apps/worker-critique`: Critique worker starter with idempotent outbox + tenant-scoped publish contract. OTel SDK + pino logger wired.
- `apps/worker-outbox-publisher`: Poll-based outbox publisher worker that emits unconsumed tenant events to NATS JetStream and marks them consumed. OTel SDK + pino logger wired; **`OutboxPublisher.publishCycle()`** and `publishPendingForTenant()` emit `outbox.publish_cycle` / `outbox.drain_tenant` spans with `outbox.events.published.total` + `outbox.cycle.duration_ms` metrics.
- `apps/worker-learning`: **Learning worker** — Phase 1 / S4 feedback loop. `LearningWorker.process()` synthesizes learning candidates from approval feedback signals. **New `processFromCritique()`** closes the Critique→Learning→Playbook cycle: consumes `critique.completed.v1` events, loads the active playbook for the artifact kind, appends corrective rubric criteria (`buildUpdatedRubricContent()`) derived from failure reasons, creates a new `PlaybookVersionRecord`, and emits `learning.playbook.updated.v1`. NATS subscription on `t.*.critique.completed.v1` wired. 22 tests (12 heuristic-path, 10 playbook-path). OTel SDK + pino logger wired.
- `apps/worker-attribution`: Attribution worker starter that computes touchpoint rollups and emits tenant-scoped attribution rollup events. OTel SDK + pino logger wired.
- `apps/worker-warmth`: Warmth worker starter that evaluates warmth threshold gating and emits tenant-scoped warmth evaluation events. OTel SDK + pino logger wired.
- `apps/worker-workflow-callback`: Workflow callback worker that emits tenant provisioning completion events. **Two execution paths**: (1) **Direct orchestrator path** — set `ENABLE_DIRECT_PROVISIONING=true` to run the `TenantProvisioningOrchestrator` 5-step sequence directly without Restate, with `OutboxProvisioningProgressReporter` writing progress to outbox + NATS; (2) **Restate verification path** — queries Restate state and replays history. OTel SDK + pino logger wired.
- `apps/worker-intel-director`: **Intel Director worker skeleton** — subscribes to `t.*.intel_brief.requested.v1` NATS subject; generates a schema-valid `IntelBriefV1` (deterministic stub, LLM-ready); enqueues to outbox via `intel-brief:{request_id}` idempotency key and publishes to `t.{tenantId}.intel_brief.v1`. 15 tests covering schema, generator, idempotency, motion-context routing.
- `apps/worker-content-strategist`: **Content Strategist worker skeleton** — subscribes to `t.*.intel_brief.v1`; for each content opportunity in the brief, calls `expandOpportunity()` (full `ContentOpportunityV1`) and `generateContentBrief()` (5-section `ContentBriefV1` with outline, keywords, tone notes, CTA); emits both artefacts to outbox + NATS. 18 tests.
- `apps/worker-blog-draft`: **Blog Draft generator worker** — subscribes to `t.*.content_brief.v1`; `generateBlogDraft()` builds structured markdown from the brief outline (5+ sections, word-count targets), computes quality indicators (has_cta, has_internal_links, heading_count); `BlogDraftWorker.processBrief()` emits `BlogDraftV1` to outbox + NATS. 17 tests.
- `apps/worker-critique`: **Critique worker** (upgraded Phase 1 S4) — optional `PlaybookVersionsRepository` enables rubric-driven scoring via `evaluateCriterion()` (6 deterministic checks: has_cta, has_evidence, no_forbidden, length_ok, has_headings, has_hook) + `evaluateRubric()` (normalised weighted aggregation). Falls back to heuristic when no active playbook. 31 tests.
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

## Observability

`@growthos/observability` provides the OTel + logging scaffolding used by all GrowthOS services.

### Tracing + metrics (OTLP/HTTP)

Set `OTEL_EXPORTER_OTLP_ENDPOINT` to enable trace and metric export (e.g. to SigNoz):

```bash
OTEL_SERVICE_NAME=growthos.api \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
pnpm dev
```

When the env var is absent, the SDK runs in no-op mode — the app behaves normally and no spans are emitted.

### Structured logging (pino)

`createLogger("growthos.api")` returns a [pino](https://getpino.io) logger. Log lines carry `service`, `level`, and `time` plus any context you pass:

```typescript
import { createLogger } from "@growthos/observability";
const log = createLogger("growthos.worker-outbox");
log.info({ tenantId, runId }, "outbox row consumed");
```

Set `LOG_LEVEL=debug` to enable debug output. Pretty-printing is enabled in non-production (`NODE_ENV !== "production"`).

### Standard metrics (three per service)

Call `createStandardMetrics(meter, prefix)` to get the canonical rate/duration/error counters:

```typescript
import { getMeter, createStandardMetrics } from "@growthos/observability";
const metrics = createStandardMetrics(getMeter("growthos.worker"), "growthos.worker");
metrics.requestsTotal.add(1, { "http.route": "/drain" });
metrics.requestsDurationMs.record(42, { "http.route": "/drain" });
```

`apps/api` mounts `createHttpMiddleware()` on every Hono route, recording these automatically.

### Optional: disable SDK entirely

```bash
OTEL_SDK_DISABLED=true pnpm dev
```

## Architecture references

- `Growthos_v4.md`
- `Growthos_v4_Technical_Architecture.md`
- `Growthos_v4_Stack_Decisions.md`
- `Growthos_v4_Implementation_Plan.md`
- `FORKING_PLAN.md`
