# GrowthOS v4 — Implementation Plan

**Companion to:** `Growthos_v4.md`, `Growthos_v4_Technical_Architecture.md`, `Growthos_v4_Stack_Decisions.md`, `paperclip_guide.md`, `anatomy_of_agentic_harness.md`, `SmarterMCP_guide.md`
**Audience:** Founder, platform engineering lead, design lead
**Status:** Sequenced, gated, opinionated build plan

---

## 0. North star

Ship a multi-tenant GTM operating system that:
- runs every agent through Paperclip with atomic checkout, budgets, and governance,
- assembles agent context just-in-time from a versioned per-tenant filesystem,
- moves work asynchronously through durable streams and durable workflows,
- holds every founder surface to operator-grade UX standards,
- and remains 100% self-hostable on a single Kubernetes cluster from day one.

If a decision violates one of those, it is wrong even if it looks expedient.

---

## 1. Engineering principles (load-bearing, not aspirational)

These are CI-enforced where possible, code-review-enforced otherwise. PRs that violate them are rejected without debate.

### 1.1 Async by default
- Any operation that crosses a service boundary, hits an LLM, or touches an external SaaS is **enqueued, never awaited inline**.
- The HTTP API returns within 200ms p95 by handing off to NATS JetStream or Restate, then streaming progress back to the UI via WebSocket.
- The only synchronous work an HTTP handler does is: validate input, write outbox+command rows in one transaction, return a tracking handle.
- "Synchronous" multi-step flows (motion re-scoring, learning candidate generation, weekly review) are Restate workflows with progress events streamed to the UI.

### 1.2 Stateless services
- No per-process state. Sessions, locks, presence, queues, leader election all live in NATS JetStream KV or Postgres.
- Any pod can serve any request. Rolling deploys never coordinate; pods are cattle.
- Caches are always rebuildable from the source of truth and TTL-bounded. A cold cache must not break correctness; only latency.

### 1.3 Idempotency everywhere
- Every external write (CRM update, email send, content publish, social post) carries an idempotency key.
- Every NATS consumer is idempotent. Re-delivery from offset replay must not double-publish or double-charge.
- Every API mutation accepts `Idempotency-Key` header; the gateway dedupes within a 24h window.
- Test rule: a "replay every job twice" chaos test runs nightly; any double-side-effect is a P0 bug.

### 1.4 Backpressure as a first-class design concern
- Per-tenant rate limits at every layer: API, NATS subject, dispatch queue, SmarterMCP session, LLM calls.
- Backpressure means **demotion**, not drop. P1 signals demote to P2 when the queue saturates; P3 demotes to digest. The founder sees a banner; nothing is lost.
- One bad tenant cannot exhaust shared resources. Budget caps + rate limits + per-tenant connection slots enforce this structurally.

### 1.5 Observability before features
- Every new module ships with: OTel spans on its public boundary, structured logs with `tenant_id`/`run_id`/`agent_id`, three Prometheus metrics minimum (rate, error, duration).
- PRs without the corresponding metrics dashboard updated are rejected.
- LLM calls are double-traced: OTel for system context, Langfuse for prompt/output context. Joined by `run_id`.

### 1.6 Tenant isolation as a tested invariant
- RLS test suite is generated, not hand-written, and runs on every PR. A single failure blocks merge.
- Every Redis/Valkey key, every NATS subject, every S3 prefix, every Gitea repo is `tenant`-prefixed. CI lints any code that constructs these keys without going through the tenant-scoped helper.
- A weekly cross-tenant red-team probe runs in staging.

### 1.7 Schema-first contracts
- Every API endpoint, every NATS event, every agent output, every handoff is a Zod schema.
- Schemas are versioned (`content_brief.v1`, `content_brief.v2`) and never deleted within a major release.
- A schema registry CI check rejects breaking changes without a `_v2` bump.

### 1.8 Latency budgets per tier
- Each surface has a published p95 budget (see §6). Perf tests assert it; regressions block merge to main.
- Latency budgets are reviewed quarterly. Tightened when met three months running; widened only with founder sign-off.

### 1.9 Replayability
- NATS JetStream offsets retained 14 days for hot streams, 90 days for learning-relevant streams.
- ClickHouse retains all time-series 18 months hot.
- Gitea retains full history forever.
- "Re-derive any decision from any point in time" is not a stretch goal — it is a daily-tested capability.

### 1.10 Migration discipline
- Every schema change is a 3-step expand-contract via **Atlas** + **pgroll**:
  1. expand (add new column/table, dual-write),
  2. backfill (idempotent, resumable),
  3. contract (drop old column/table after a release of dual-read).
- No release contains a non-additive migration. Period.

### 1.11 Rust where measured to matter; TypeScript everywhere else
- TS first. Hot paths (Signal Router, Confidence fast-path, outbox-publisher, Attribution Aggregator) graduate to Rust **only after** a perf test demonstrates the TS implementation can't hold p95 with linear scale.
- Rust is not a status symbol. Premature Rust slows phase 1.

### 1.12 Twelve-factor + GitOps
- One artifact, many environments. Config via env vars + secret references resolved at boot from OpenBao.
- Every deploy is a Git commit on the IaC repo (Pulumi/OpenTofu) flowing through Argo CD.
- No `kubectl apply` from a laptop. Ever.

### 1.13 Feature flags as the rollout primitive
- New surfaces, new agents, new policy tiers, new auto-approve unlocks all gate behind GrowthBook flags scoped per tenant.
- A feature flag without an expiration date is a P2 issue.

### 1.14 No reflection on agent intent
- Agents do not call into platform internals. They go through Paperclip MCP tools, SmarterMCP tools, or our domain MCP servers.
- Direct DB access from an LLM-touched code path is forbidden — caught by a CI grep on the adapter package.

---

## 2. Build order at a glance

```
Phase 0  Foundations             weeks  -2 → 0    (cannot skip)
Phase 1  Trustworthy compression weeks   1 → 10   (proves the wedge)
Phase 2  Compounding value       weeks  11 → 20   (proves the moat)
Phase 3  Operating leverage      weeks  21 → 32+  (proves enterprise)
```

Each phase has a sharp exit criterion. Do not begin the next phase until the current one's exit criteria pass in production with a real (or bench) tenant.

---

## 2.1 Current implementation snapshot (updated)

This section tracks what is already implemented in the `GTM` repo so execution status is explicit and not inferred from architecture docs.

**Last updated:** 2026-04-28

### Progress dashboard (implementation status)

| Phase / Track | Status | Progress |
|---|---|---:|
| Phase 0 / Track A (Repo + tooling) | In progress (GitHub Actions: Biome + typecheck + tests + Postgres **`migrate:dry-run` + Atlas validate/lint** + **RLS invariant tests** on PR/push; root **Docker Compose** for full Phase-0 local stack: Postgres + NATS + Valkey + MinIO + ClickHouse + Qdrant + Gitea + Meilisearch + **OpenBao**; **`@growthos/observability`** OTel + pino logging package wired into **`apps/api`** and **all 7 workers**; `OutboxPublisher.publishCycle()` + `publishPendingForTenant()` emit OTel spans + metrics; **generated RLS invariant test suite** for all 5 tenant tables; **3 operational runbooks** for NATS / Postgres / OpenBao) | 100% |
| Phase 0 / Track B (Data plane) | In progress (Drizzle ORM + drizzle-kit + **Atlas validate + migrate lint + migrate apply** wired; **`pnpm seed:dev`** provisions dev tenant across Postgres + NATS + **`playbook_versions` (blog_draft + content_brief rubric seeds)**; **all 8 data-plane services** in Compose; **pgroll expand–contract workflow** wired (`migrate:expand`, `migrate:contract`, `migrate:rollback`, `migrate:status` scripts + WORKFLOW.md guide + 2 annotated example migrations); **`playbook_versions` + `signal_events` tables** — Drizzle schema + migration `0001_narrow_lake.sql` + RLS policies + atlas.sum + 2 new RLS specs) | 97% |
| Phase 0 / Track C (Event + workflow plane) | In progress (Postgres outbox + NATS publisher + all worker starters + loop hardening + notify/lease coordination + Restate triggers + typed runtime client + signed callback ingestion + progress replay contract + workflow state machine + callbackType routing + failed terminal event + progress-only endpoint + **persistent workflow_runs state store + real CAS-based transition enforcement + NATS-driven workflow-callback consumer + runtime-history-verified terminal state emission + infra-smoke Restate state contract hook**) | 100% |
| Phase 0 / Track D (LLM + harness infra) | In progress (**`@growthos/llm-harness`** package: `PromptTemplate` + `definePrompt()` factory; `LlmCallRunner` interface; `StubLlmCallRunner`; `OpenAiLlmCallRunner` (retry, OTel, cost); 4 built-in prompt templates; 24 unit tests; **`LlmCallLogSink`** observability pipeline: `NoopLlmCallLogSink`, `ClickHouseLlmCallLogSink` (HTTP JSONEachRow insert, error-resilient), `BufferedLlmCallLogSink` (batch flush, auto-flush timer, `insertRows()` batch preference), `buildLogRow()` helper; wired as optional dep into `OpenAiLlmCallRunner`; `llm_call_logs` ClickHouse DDL added to `001_init.sql` (MergeTree, 24-month TTL); 16 additional unit tests (40 total in `llm-harness`)) | 80% |
| Phase 0 / Track E (Identity/billing/secrets/deploy) | Not started | 0% |
| Phase 0 / Track F (Paperclip fork hardening) | In progress (`growthos_native`, scheduler leases, Postgres LiveEvents fanout, additive RLS baseline, expanded strict RLS route batch + route tests complete; `issues` labels + expanded reads + low-risk/high-churn mutations with scoped helper cleanup effectively complete) | 99% |
| Phase 1 / S1 (Adapter + tenant provisioning starter) | In progress (adapter/API scaffolding complete; **`TenantProvisioningOrchestrator`** + typed client interfaces + 5-step sequence + stub implementations + 19 tests wired; **`OutboxProvisioningProgressReporter`** bridges orchestrator progress to outbox+NATS; **`worker-workflow-callback` orchestrator path** wired — `ENABLE_DIRECT_PROVISIONING=true` runs 5-step sequence directly without Restate; **`HttpGiteaProvisioningClient`** + **`HttpMinioProvisioningClient`** real HTTP clients behind `ENABLE_REAL_GITEA_CLIENT` / `ENABLE_REAL_MINIO_CLIENT` env flags; 16 HTTP client tests + env-flag routing in `worker-workflow-callback/src/index.ts`) | 98% |
| Phase 1 / S2 (Motion Engine starter) | In progress (deterministic scorer v1 complete; **handoff contracts v0** wired: `intel_brief.v1`, `content_opportunity.v1`, `content_brief.v1`, `blog_draft.v1` schemas + registry + 22 tests; **skills library v0** 5 files; **`POST /v1/signals`** signal ingest route: `IngestSignalRequest` Zod schema, `X-Tenant-Id` header, idempotent `SignalEventsRepository.ingest()`, 5 API tests) | 65% |
| Phase 1 / S3 (Intel Director + Content Strategist + Blog Draft) | In progress (**`worker-intel-director`** skeleton complete; **`worker-content-strategist`** skeleton complete; `expandOpportunity()` expands `BriefOpportunityRef` → full `ContentOpportunityV1` (format, hook, evidence, audience); `generateContentBrief()` produces 5-section `ContentBriefV1` (outline, keywords, tone notes, CTA, word-count estimate, confidence score); `ContentStrategistWorker.processBrief()` emits both artefacts per opportunity; NATS consumer on `t.*.intel_brief.v1`; 18 tests: generators (2×6), integration (5: happy path, idempotency, multi-opportunity, invalid input, unique brief_ids); **`worker-blog-draft`** skeleton complete: `generateBlogDraft()` builds 5-section markdown from `ContentBriefV1` outline, computes quality indicators (has_cta, has_internal_links, heading_count), `BlogDraftWorker.processBrief()` emits to outbox+NATS, 17 tests) | 85% |
| Phase 1 / S4 (Critique/learning loop) | In progress (**`CritiqueWorker`** upgraded with `PlaybookVersionsRepository`-driven rubric scoring (31 tests); **`LearningWorker.processFromCritique()`** closes the feedback loop: consumes `critique.completed.v1` → appends corrective rubric criteria → `PlaybookVersionsRepository.create()` → emits `learning.playbook.updated.v1`; `buildUpdatedRubricContent()` merges failure reasons into existing/default rubric; `resolvePlaybookType()` maps artifact kinds to playbook types; NATS subscription on `t.*.critique.completed.v1` wired in `worker-learning/src/index.ts`; 22 total learning worker tests (10 new playbook-path tests); **`seed-dev-cli.ts`** seeds `blog_draft` + `content_brief` rubric playbooks for dev tenant — closes local dev end-to-end loop) | 85% |
| Phase 1 / S5-S6 (UI, distribution) | In progress (**`@growthos/web`** Next.js 15 App Router app: approval queue page (Server Component + Server Actions, per-draft approve/reject, quality indicators, reviewer note), motion stack overview (motion scores grid + scorer metadata), signal ingest page (Client Component, all 6 signal types, idempotent dedup feedback); **`ApiClient`** typed wrappers (Zod-validated `listApprovals`, `submitApprovalDecision`, `ingestSignal`); Tailwind CSS 3 + Inter font; `apps/web` added to `pnpm` workspace; **`ApprovalFeedbackRepository`** + `PostgresApprovalFeedbackRepository` + `InMemoryApprovalFeedbackRepository` (`@growthos/db`); **`GET /v1/approvals`** + **`POST /v1/approvals/decide`** API routes (9 tests); monorepo: 34 API tests, 21 packages passing) | 35% |

### Completed in code (this repo)

- **Phase 0 / Track A (Repo + tooling)**
  - Monorepo scaffolded with `pnpm`, `turbo`, `typescript`, `biome`, `vitest`.
  - Packages created: `@growthos/core`, `@growthos/api`, `@growthos/adapter`, `@growthos/skills`, `@growthos/design-system`, `@growthos/test-utils`.
  - Workspace validation commands are green (`pnpm check`, `pnpm typecheck`, `pnpm test`).
  - **GitHub Actions CI** (`.github/workflows/ci.yml`): on push/PR to `main` or `master`, runs `pnpm check`, `pnpm typecheck`, `pnpm test`, plus **`migration-dry-run`** (Postgres 16 service): `pnpm --filter @growthos/db migrate:dry-run` (same as local `pnpm migrate:dry-run`), then Atlas steps below.
  - **Atlas in CI** (same **`migration-dry-run`** job as Postgres apply): after `migrate:dry-run`, installs Atlas **v1.2.0** via [`ariga/setup-atlas@v0.3`](https://github.com/ariga/setup-atlas), runs **`atlas migrate validate`** (`drizzle/atlas.sum` vs SQL), creates scratch DB **`atlas_lint`**, then **`atlas migrate lint --latest 1`** with destructive policy from [`packages/db/atlas.hcl`](packages/db/atlas.hcl). Local: `pnpm atlas:validate`, `pnpm atlas:lint` with `ATLAS_LINT_DEV_URL` or Docker; after SQL edits: `pnpm --filter @growthos/db db:atlas-hash`.
  - **Local Docker Compose** (`compose.yaml` + `pnpm infra:up` / `infra:down` / `infra:ps`): full Phase-0 data/event plane on non-default ports — Postgres 16 (**5488**), NATS JetStream (**4228** / **8228**) with **`jetstream-init`** (`natsio/nats-box`), **Valkey 8** (**6388**), **MinIO** (**9088** S3 / **9089** console) with `minio-init` creating `growthos` + `growthos-assets` buckets, **ClickHouse 24** (**8124** HTTP / **9010** native) with `packages/db/clickhouse/001_init.sql` DDL (`growthos.activity_log`, `growthos.cost_events`, `growthos.signal_attribution`), **Qdrant v1.12** (**6343** HTTP / **6344** gRPC), **Gitea v1.22-rootless** (**3088** HTTP / **2222** SSH, SQLite dev mode), **Meilisearch v1.11** (**7701**).
  - **`@growthos/observability`** package added (`packages/observability`): `getTracer()`, `getMeter()`, `createStandardMetrics()` (rate/duration/error metric bundle per Principle 1.5), `createLogger()` (pino structured JSON logger with `service`/`level`/`time` + caller-provided `tenantId`/`runId`/`agentId`/`traceId`), `initOtelSdk()` (OTLP/HTTP trace + metrics exporter to SigNoz/Jaeger; no-op when `OTEL_EXPORTER_OTLP_ENDPOINT` unset), `createHttpMiddleware()` (Hono middleware: SERVER span per request + standard 3 metrics). SIGTERM shutdown handler wired.
  - **`apps/api`** upgraded: `createHttpMiddleware` from `@growthos/observability` mounted on every route; `initOtelSdk("growthos.api")` called in `src/index.ts` before any app code; `createLogger("growthos.api")` replaces `console.log`; `GET /health` now returns service version.
  - **All 7 workers** wired with `@growthos/observability`: each worker entry point calls `initOtelSdk({ serviceName: "growthos.worker-X" })` and uses a `createLogger("growthos.worker-X")` pino logger replacing all `console.log`/`console.error` calls. Worker-specific context logged at startup (`tenantIds`, `pollIntervalMs`, NATS subject).
  - **`OutboxPublisher`** (`worker-outbox-publisher`) traces production drain path: `publishCycle` → `outbox.publish_cycle` span (SERVER kind, `tenant.count` + `total_published` attrs); `publishPendingForTenant` → `outbox.drain_tenant` span (`tenant.id` + `published_count` attrs). Metrics: `outbox.events.published.total` counter (per-tenant label) and `outbox.cycle.duration_ms` histogram. All OTel primitives re-exported from `@growthos/observability` so no direct `@opentelemetry/api` dep needed in consumers.
  - **Generated RLS invariant test suite** (`packages/db/src/rls-test-generator.ts` + `src/rls-invariants.test.ts`): `RlsTableSpec` interface + `generateRlsInvariantCases()` derive three invariant cases per tenant-scoped table (owner reads own rows, other tenant blocked, no-context returns zero under FORCE RLS). `GROWTHOS_RLS_TABLE_SPECS` covers all 5 tables; adding a table requires one spec entry. Tests use dedicated `pg.Client` instances per role (owner / other / anon), run only when `DATABASE_URL` is set (`describe.skipIf`), and clean up via RLS-safe DELETE in `afterAll`.
  - **Local Docker Compose** upgraded: **OpenBao 2.2** (`openbao/openbao:2.2.0`) added on port **8200** in dev mode (root token `growthos-dev-root-token`, in-memory, Vault-compatible API). Completes the Track B infra coverage: all 8 services live.
  - **pgroll expand–contract workflow** added to `packages/db/pgroll/`: `WORKFLOW.md` (3-phase diagram, decision table for when pgroll vs plain Drizzle, step-by-step procedure, troubleshooting table); `migrations/001_add_quality_score_to_motion_scores.yaml` (additive column with backfill); `migrations/002_rename_rationale_to_scorer_rationale.yaml` (zero-downtime rename). Root scripts: `migrate:expand` (wraps `pgroll start`), `migrate:contract` (wraps `pgroll complete`), `migrate:rollback`, `migrate:status`.
  - **RLS invariant tests wired into CI**: new `rls-invariants` job in `.github/workflows/ci.yml` with Postgres 16 service, applies migration via `migrate:dry-run`, then runs `pnpm --filter @growthos/db test` with `DATABASE_URL` set — all 15 generated cases run on every PR per Phase 0 exit criterion.
  - **Operational runbooks** added (`docs/runbooks/`): `nats-leader-loss.md` (detection, Compose vs prod recovery, outbox catch-up, post-incident checklist); `postgres-failover.md` (Patroni auto vs manual promote, RLS verification, replica rejoin); `openbao-seal-unseal.md` (Shamir key-share procedure, KMS auto-unseal, emergency seal, post-incident).
- **Phase 1 / S1 — Orchestrator wired into `worker-workflow-callback`**
  - **`OutboxProvisioningProgressReporter`** (`apps/worker-workflow-callback/src/outbox-progress-reporter.ts`): implements `ProvisioningProgressReporter`; each `report()` enqueues a deterministically-keyed progress event in the outbox (durable) and publishes immediately to `t.{tenantId}.workflow.tenant_provisioning.progress.v1` (live push). Idempotency key: `orchestrator:{workflowId}:{step}:{percent}` — replay-safe.
  - **`WorkflowCallbackWorker`** extended with optional `provisioningClients?: ProvisioningClients` dep. When present: creates `TenantProvisioningOrchestrator` per request with fresh reporter, runs 5-step sequence, emits `completed` / `failed` terminal events, transitions `workflow_runs` state. When absent: legacy Restate verification path unchanged.
  - **`resolveProvisioningClients()`** in `index.ts`: stub clients activated by `ENABLE_DIRECT_PROVISIONING=true`; future-proofed for real HTTP clients when `PAPERCLIP_BASE_URL`, `GITEA_BASE_URL`, etc. are set.
  - 4 new orchestrator-path tests (total 7 tests in suite): happy path (5 steps + events), state transitions, idempotency after completion, failure propagation.
- **Phase 1 / S3 — Content Strategist + Blog Draft workers**
  - **`@growthos/worker-content-strategist`** (`apps/worker-content-strategist/`): full worker app.
  - `expandOpportunity(brief, ref)` — expands a compact `BriefOpportunityRef` from an `IntelBriefV1` into a full `ContentOpportunityV1`: motion-derived `content_format` map (plg→long_form_blog, outbound_multichannel→email, abm→case_study, etc.), audience, hook (≥10 chars), and a baseline evidence record.
  - `generateContentBrief(opportunity)` — produces a 5-section `ContentBriefV1`: Introduction, Core Framework, Evidence & Examples, Implementation Guide, Conclusion & CTA. Each section has `key_points`, `word_count_target`. Sets PLG-specific tone hint when motion is `plg`. `confidence_score` = `min(opportunity.score / 2, 1)`.
  - `ContentStrategistWorker.processBrief(input)` — validates `IntelBriefV1` input, loops over all `content_opportunities`, enqueues both artefacts via outbox (idempotency keys `content-opportunity:{brief_id}:{opp_id}` / `content-brief:{brief_id}:{opp_id}`), publishes to `t.{tenantId}.content_opportunity.v1` + `t.{tenantId}.content_brief.v1`.
  - NATS consumer on `t.*.intel_brief.v1` with queue group.
  - 18 tests: `expandOpportunity` (6), `generateContentBrief` (7), worker integration (5: emit, idempotency, multi-opp, invalid input, unique brief_ids).
  - **`@growthos/worker-blog-draft`** (`apps/worker-blog-draft/`): full worker app.
  - `generateBlogDraft(brief)` — deterministic skeleton: outline sections → markdown H2 + bullet paragraphs; `meta_description` truncated to 160 chars from hook; quality indicators computed (has_cta, has_internal_links, heading_count, flesch_score=null, grade_level=null); unique `draft_id` per call.
  - `BlogDraftWorker.processBrief(input)` — validates `ContentBriefV1`, generates `BlogDraftV1`, enqueues via `blog-draft:{brief_id}:{iteration}` idempotency key, publishes to `t.{tenantId}.blog_draft.v1`. NATS consumer on `t.*.content_brief.v1` with queue group.
  - 17 tests: generator (13), worker integration (3: emit, idempotency, invalid input).
- **Phase 1 / S4 — Critique worker playbook upgrade**
  - **`playbook-rubric.ts`** — `RubricPlaybookContent` + `RubricCriterion` Zod schemas; `evaluateCriterion(check, text, config)`: 6 deterministic checks (has_cta — CTA phrase patterns; has_evidence — numbers/percentages/study refs; no_forbidden — phrase blocklist; length_ok — word count range; has_headings — markdown H2/H3; has_hook — substantive opening); unknown checks auto-pass (LLM-ready extension point).
  - `evaluateRubric(content, text)` — loops all criteria, normalises weights to sum=1, aggregates weighted score, collects failure reasons.
  - `artifactKindToPlaybookType(kind)` — maps `blog_draft.v1` → `blog_draft`, `content_brief.v1` → `content_brief`, etc.
  - `CritiqueWorker` upgraded: optional `playbookRepository?: PlaybookVersionsRepository` dependency; `scoreWithPlaybook()` loads active playbook for artifact kind, validates content shape, runs `evaluateRubric`, maps score to verdict (≥0.8→approve, ≥0.5→revise, <0.5→reject); graceful fallback to heuristic when no repo, no playbook, or invalid content.
  - 31 tests: heuristic (4), `evaluateCriterion` (11), `evaluateRubric` (3), worker heuristic (2), worker playbook (8: approve, revise, reject, fallback-no-playbook, fallback-invalid-content, content_brief artifact, reasons non-empty), mapping (3).
- **Phase 1 / S1 — Real HTTP provisioning clients**
  - **`HttpGiteaProvisioningClient`** (`packages/core/src/provisioning-http-clients.ts`): native `fetch` against Gitea v1 REST API; `GiteaClientConfig` interface + `fromEnv()` factory. `provisionWorkspaceRepo`: GET existence check → POST `/generate` from template; 409 race treated as idempotent (re-GET). `createOrUpdateFile`: GET file SHA → POST (create) or PUT (update, include SHA); helper methods `getRepoUrl()` + `getFileSha()`.
  - **`HttpMinioProvisioningClient`**: `@aws-sdk/client-s3` with `forcePathStyle=true`; `MinioClientConfig` + `fromEnv()` factory. `provisionBucket`: `HeadBucketCommand` existence check → `CreateBucketCommand`; distinguishes 404/NoSuchBucket from other errors (permission, network) — only former treated as "not found".
  - **`worker-workflow-callback` env-flag routing**: `ENABLE_REAL_GITEA_CLIENT=true` → `HttpGiteaProvisioningClient.fromEnv()`, `ENABLE_REAL_MINIO_CLIENT=true` → `HttpMinioProvisioningClient.fromEnv()`; independent flags for staged roll-out.
  - 16 tests: `provisionWorkspaceRepo` (4), `createOrUpdateFile` (3), `provisionBucket` (4), `fromEnv` validation (5).
- **Phase 0 / Track B — Data layer repositories**
  - **`PlaybookVersionsRepository`** (`packages/db/src/playbook-versions-repository.ts`): interface + `InMemoryPlaybookVersionsRepository` + `PostgresPlaybookVersionsRepository`. Methods: `getActive(tenantId, type)` → latest non-retired; `listAll(tenantId, type)` → all versions newest-first; `create(tenantId, params)` → auto-version (MAX+1 in transaction); `retire(tenantId, id)` → soft-retire with idempotency. 11 unit tests: null-state, version auto-increment, independent counters per type, getActive after retire, idempotent retire, tenant scope, listAll, content payload.
  - **`SignalEventsRepository`** (`packages/db/src/signal-events-repository.ts`): interface + `InMemorySignalEventsRepository` + `PostgresSignalEventsRepository`. Methods: `ingest(params)` → partial-unique dedup by `(tenantId, source, externalId)` when `externalId` is set (no dedup when absent); `listUnprocessed(tenantId, type, limit)` → FIFO; `markProcessed(tenantId, ids)` → idempotent bulk update. 13 unit tests.
  - **`migrate-dry-run-cli`** updated: `resolveMigrationFiles()` scans `drizzle/` dir for `*.sql` files sorted lexicographically — all new migrations auto-applied without script change; `CORE_TABLES` extended to 7 (adds `playbook_versions`, `signal_events`). `GROWTHOS_MIGRATE_SQL` env override preserved for single-file CI runs.
- **Phase 1 / S3 — Intel Director worker skeleton**
  - **`@growthos/worker-intel-director`** (`apps/worker-intel-director/`): full worker app (package.json, tsconfig, src).
  - `intelBriefRequestedV1Schema` — versioned request contract with `request_id`, `tenant_id`, `period_from/to`, `requested_by`, and optional `motion_context` (primary motions + ICP summary).
  - `generateDeterministicBrief()` — Phase 1 stub generator: produces a schema-valid `IntelBriefV1` with empty signals, one motion-derived `content_opportunity`, and a `recommended_focus` incorporating ICP context. Validated against `intelBriefV1Schema` before return. Drop-in-replaceable with LLM backend in S5.
  - `IntelDirectorWorker.processBriefRequest()` — idempotent: enqueues to outbox via `intel-brief:{request_id}` idempotency key, publishes to `t.{tenantId}.intel_brief.v1`.
  - NATS consumer on `t.*.intel_brief.requested.v1` with configurable queue group; `WORKER_BOOTSTRAP=true` startup with `initOtelSdk` + `createLogger`.
  - 15 tests: request schema (4), generator (7), worker integration (4: happy path, idempotency, invalid input, motion context).
- **Phase 0 / Track B — `playbook_versions` + `signal_events` tables**
  - **`playbook_versions`** table in `schema.ts`: tenant-scoped, typed by `PlaybookTypeValue` (content_brief / intel_brief / blog_draft / custom), versioned with unique `(tenant_id, playbook_type, version)`, has `retired_at` for soft-retirement. CHECK constraint on type. RLS policy (ENABLE + FORCE + tenant isolation policy).
  - **`signal_events`** table: high-volume write path, `bigserial` PK, typed by `SignalTypeValue` (competitive / community / icp / product / market / internal), partial unique index `(tenant_id, source, external_id) WHERE external_id IS NOT NULL` for deduplication, partial index on unprocessed rows. RLS policy.
  - Migration `drizzle/0001_narrow_lake.sql` generated by drizzle-kit + RLS policies appended manually. `atlas.sum` updated using Atlas `h1:` hash algorithm (SHA-256 of `filename+content`).
  - `GROWTHOS_RLS_TABLE_SPECS` extended with 2 new entries (21 RLS invariant cases now generated). Exports added to `@growthos/db` public API.
- **Phase 1 / S2 Domain starter**
  - Deterministic `Motion Engine` starter implemented in `@growthos/core` with versioned scorer output and tests.
- **Phase 0 / Track B Data-plane starter**
  - `@growthos/db` package added.
  - **Drizzle ORM + drizzle-kit** adopted as the data layer:
    - `src/schema.ts` defines all five tables (`motion_scores`, `motion_stack`, `approval_feedback`, `event_outbox`, `workflow_runs`) as typed Drizzle table objects with CHECK constraints, indexes, unique constraints, and foreign keys — TypeScript is the source of truth.
    - `drizzle.config.ts` configures drizzle-kit for `drizzle-kit generate` / `drizzle-kit migrate` / `drizzle-kit studio`.
    - `drizzle/0000_yielding_inertia.sql` is the auto-generated migration (all DDL derived from `schema.ts`), with RLS `ENABLE`/`FORCE`/`CREATE POLICY` statements appended post-generation as security invariants.
    - `src/db.ts` exports `createDb`, `createDbFromEnv`, and `GrowthOsDb` (typed Drizzle client).
    - `scripts: { "db:generate", "db:migrate", "db:studio", "db:atlas-hash", "db:atlas-validate", "db:atlas-lint", "db:migrate-apply", "db:seed-dev" }` added to `package.json`; **`atlas.hcl`** (with `url = getenv("DATABASE_URL")`) + committed **`drizzle/atlas.sum`** integrate [Atlas](https://atlasgo.io/) migration-directory integrity, lint policy, and **`atlas migrate apply`** for production applies (`pnpm atlas:validate`, `pnpm atlas:lint`, `pnpm migrate:apply` at repo root).
    - **`pnpm seed:dev`** (`packages/db/src/seed-dev-cli.ts`): idempotent dev-tenant provisioner — inserts `motion_scores`, `motion_stack`, `approval_feedback`, `event_outbox` (idempotency sentinel), `workflow_runs` for well-known tenant `00000000-0000-0000-0001-000000000001` (override via `GROWTHOS_DEV_TENANT_ID`); optionally publishes seed event to NATS when `NATS_SERVERS` is set.
  - All raw SQL strings removed from repositories; `PostgresOutboxRepository` and `PostgresWorkflowRunRepository` use typed Drizzle query builder (`insert`, `select`, `update`, `onConflictDoNothing`, `returning`, `limit`, `orderBy`).
  - Tenant RLS context set via `tx.execute(sql\`SELECT set_config...\`)` inside Drizzle transactions — no `BEGIN`/`COMMIT`/`ROLLBACK` boilerplate; Drizzle manages the transaction lifecycle.
  - `PostgresCycleLeaseGuard` in `worker-outbox-publisher` migrated from raw `PgPool` to Drizzle `db.transaction` + `tx.execute` for `pg_try_advisory_xact_lock`.
  - All 8 worker entry points updated from `createPgPoolFromEnv` → `createDbFromEnv`.
  - `@growthos/infra-smoke` updated to use `createDb` directly.
  - `src/index.ts` re-exports schema types, Drizzle table objects, and all repository interfaces cleanly with no duplicate-export conflicts.
  - Migration contract tests now verify the generated migration file (not hand-written SQL); schema tests verify Drizzle column metadata.
  - **`migrate:dry-run`**: `packages/db/src/migrate-dry-run-cli.ts` (via `pnpm migrate:dry-run` at repo root or `pnpm --filter @growthos/db migrate:dry-run`) loads `packages/db/ci/bootstrap.sql`, splits `drizzle/0000_yielding_inertia.sql` with `splitDrizzleMigrationSql` (Drizzle `--> statement-breakpoint` markers, including same-line `;-->` cases), executes each chunk with `pg`, then asserts `growthos` core tables exist. **CI uses this script only** (no parallel `psql` path). Unit tests in `split-drizzle-migration-sql.test.ts`.
  - Old hand-written `migrations/` folder removed.
- **Phase 0 / Track C Event-plane starter**
  - `@growthos/worker-signal-router` app added.
  - Real NATS JetStream publisher implemented using the `nats` client.
  - Signal Router service implemented with deterministic stage-1 classification, outbox enqueue, and tenant-scoped NATS publishing.
  - Worker tests cover routing, duplicate signal idempotency, and JetStream publish boundary.
  - `@growthos/worker-critique` starter app added with schema-first critique contracts, deterministic scoring stub, idempotent outbox write, tenant-scoped NATS publish, and unit tests.
  - `@growthos/worker-outbox-publisher` starter app added with tenant-scoped polling, outbox publish+consume semantics, env-driven runtime config, and unit tests for success/failure/cycle behavior.
  - Outbox publisher runtime hardened with non-overlapping cycle runner, explicit cycle error isolation/logging hook, and companion runner tests.
  - Outbox publisher now supports Postgres `LISTEN/NOTIFY` wakeups (`growthos_outbox_events`) and per-cycle Postgres advisory lease coordination for multi-instance-safe draining.
  - `@growthos/worker-learning` starter app added with schema-first learning contracts, deterministic candidate synthesis from approval feedback signals, idempotent outbox write, tenant-scoped NATS publish, and unit tests.
  - `@growthos/worker-attribution` starter app added with schema-first attribution rollup contracts, deterministic touchpoint/channel aggregation, idempotent outbox write, tenant-scoped NATS publish, and unit tests.
  - `@growthos/worker-warmth` starter app added with schema-first warmth contracts, deterministic warmth-threshold/cold-override evaluation, idempotent outbox write, tenant-scoped NATS publish, and unit tests.
  - Restate workflow starter wiring added: `@growthos/core` workflow hello contracts + deterministic workflow stub, and API `POST /v1/workflows/hello` route that enqueues `workflow.hello.requested.v1` via outbox with tests.
  - Restate tenant provisioning trigger slice wired: `@growthos/core` tenant provisioning workflow contracts + deterministic accepted-stub and API `POST /v1/workflows/tenant-provisioning` route that enqueues `workflow.tenant_provisioning.requested.v1` via outbox with tests.
  - Workflow completion callback starter added: `@growthos/worker-workflow-callback` consumes tenant provisioning request contracts and emits `workflow.tenant_provisioning.completed.v1` through outbox + tenant-scoped publish with tests.
  - `worker-workflow-callback` now runs a real NATS consumer (`t.*.workflow.tenant_provisioning.requested.v1` by default, queue-grouped), transitions `workflow_runs` from `requested` → `in_progress`, emits explicit progress + completed events via outbox + tenant-scoped publish, and finalizes state to `completed` with idempotent terminal-state guards.
  - Restate runtime-history verification wired into callback worker path:
    - `@growthos/core` `RestateHttpWorkflowClient` now supports `getTenantProvisioningRuntimeState(...)` for runtime-run status + replay history retrieval.
    - Callback worker replays runtime history as `workflow.tenant_provisioning.progress.v1` events.
    - Callback worker emits terminal event based on runtime-verified state (`completed` or `failed`) instead of deterministic local acceptance.
    - `workflow_runs` now transitions to terminal states based on runtime-verified outcome.
  - Typed Restate runtime client seam wired in `@growthos/core` with env-based HTTP client resolution and non-blocking API dispatch hooks for hello + tenant provisioning workflow triggers.
  - Runtime callback ingestion endpoint wired: API `POST /v1/workflows/runtime-callbacks/tenant-provisioning` parses typed callback payloads and enqueues `workflow.tenant_provisioning.completed.v1` idempotently using callback IDs.
  - Runtime callback security + replay hardening wired: optional HMAC signature validation (`RESTATE_CALLBACK_SECRET`) and explicit `workflow.tenant_provisioning.progress.v1` replay contract emitted before completion events.
  - **Workflow state machine contract added** (`packages/core/src/workflow-state.ts`): `workflowRunStateSchema` (`requested → in_progress → completed/failed`), `callbackTypeSchema`, `validateWorkflowTransition` with terminal-state guards, `isTerminalState`, `callbackTypeToState`, `isCallbackLegalFromState`, and 26 unit tests covering all valid/invalid transitions.
  - **`callbackType` discriminator wired** into `tenantProvisioningRuntimeCallbackSchema` (default `completed` for backwards compat). Command builders updated to accept Zod input type (defaulted fields optional). New `createTenantProvisioningFailedOutboxCommand` builder added for `workflow.tenant_provisioning.failed.v1` events with `failureCode`/`failureMessage` payload.
  - **Callback route dispatches by `callbackType`**: `progress` → emits 1 progress event; `completed` → emits progress + completed; `failed` → emits progress + failed. Transition legality validated via `validateWorkflowTransition` before event emission, returning `409` on illegal transitions.
  - **Dedicated progress-only endpoint** added: `POST /v1/workflows/runtime-callbacks/tenant-provisioning/progress` — emits exactly 1 `workflow.tenant_provisioning.progress.v1` event per call with full signature-verification support.
  - API response now returns `callbackType` and `targetState` fields for caller-side state machine alignment.
  - **Persistent workflow run state store implemented** (`packages/db/src/schema.ts` + `packages/db/drizzle/*.sql` + `packages/db/src/workflow-run-repository.ts`):
    - `workflow_runs` table with `state` column enforced by `CHECK` constraint and terminal-state `NOT IN` guard on `UPDATE`.
    - RLS policy and unique index on `(tenant_id, workflow_id)` for tenant isolation.
    - `WorkflowRunRepository` interface with `upsertRequested` (idempotent), `transitionState` (atomic CAS with terminal blocking), and `getByWorkflowId`.
    - `InMemoryWorkflowRunRepository` (tests/dev) and `PostgresWorkflowRunRepository` (production) implementations.
    - Terminal state invariant enforced at both the in-memory layer (guard check before mutation) and the Postgres layer (`AND state NOT IN ('completed', 'failed')` in `UPDATE`).
  - **Callback route upgraded**: reads stored `WorkflowRun` state before transition, performs `validateWorkflowTransition`, executes `transitionState` CAS, returns `409 Conflict` on illegal transition or concurrent update. Gracefully degrades to permissive validation when no state store is configured.
  - **`POST /v1/workflows/tenant-provisioning`** now calls `upsertRequested` to durably record the workflow run as `requested` before emitting the outbox event.
  - `@growthos/infra-smoke` app added for opt-in live Postgres outbox + NATS JetStream smoke verification; uses **`OutboxPublisher` + `NatsJetStreamPublisher`** from `@growthos/worker-outbox-publisher` to drain the enqueued row (production path), asserts `consumed_at` via empty `listUnconsumed`, then reads JetStream with **`last_by_subj`** on `t.<tenant>.growthos.infra_smoke.v1` and validates payload; optional Restate `getTenantProvisioningRuntimeState` when `RESTATE_BASE_URL` + `GROWTHOS_SMOKE_WORKFLOW_ID` are set together; `parseSmokeEnv` + unit tests.
- **Phase 0 / Track F Paperclip fork starter**
  - Local Paperclip fork now recognizes `growthos_native` as a built-in adapter type.
  - Server adapter registry, shared adapter constants, and UI adapter/display registry updated.
  - `growthos_native` currently delegates execution to GrowthOS and fails closed if invoked directly before the GrowthOS heartbeat worker is active.
  - Adapter registry/UI registry tests added in the Paperclip fork.
  - Paperclip fork install blocker fixed by adding `node-addon-api` for `sharp` native builds.
  - Scheduler lease runner added around heartbeat timers, routine schedules, and heartbeat recovery. It uses Postgres advisory transaction locks plus an in-process overlap guard.
  - LiveEvents fanout upgraded from process-local only to optional Postgres `LISTEN/NOTIFY` cross-process fanout with origin IDs to avoid echo loops.
  - Additive company-scoped RLS readiness migration added in the Paperclip fork. It enables RLS and policy generation while staying compatible until strict request-scoped DB context is wired.
  - Strict RLS transaction helper added in the Paperclip server and applied to dashboard plus company-scoped `goals`, `activity`, `inbox-dismissals`, sidebar project-preference, sidebar-badges, user-profile, company-skills, costs/budget, environments, approvals, assets upload/content, projects list/get/create/update + workspace CRUD + runtime control, secrets, routines (list/detail/update/triggers/run), and `issues` labels (list/create/delete), company list, expanded read paths (`GET /issues/:id`, `GET /issues/:id/heartbeat-context`, `GET /issues/:id/work-products`, `GET /issues/:id/documents`, `GET /issues/:id/documents/:key`, `GET /issues/:id/documents/:key/revisions`, `GET /issues/:id/comments`, `GET /issues/:id/interactions`), low-risk mutations (`POST/DELETE /issues/:id/read`, `POST/DELETE /issues/:id/inbox-archive`), approvals link management (`GET/POST/DELETE /issues/:id/approvals...`), work-products mutations (`PATCH/DELETE /work-products/:id`, plus scoped create path), document mutations (`PUT /issues/:id/documents/:key`, restore revision, and `DELETE /issues/:id/documents/:key`), checkout/release paths (`POST /issues/:id/checkout`, `POST /issues/:id/release`, `POST /issues/:id/admin/force-release`), interaction decision endpoints (`accept`, `reject`, `respond`), plus issue delete and interaction create mutations.
  - Focused route tests now assert strict RLS scoping for company-scoped `goals`, `activity`, `inbox-dismissals`, sidebar project-preference, sidebar-badges, user-profile, company-skills, costs/budget, environments, approvals list/decision/comment, assets reads/writes, projects list/get/create/update + workspace CRUD + runtime control, secrets, routines list/detail/update/triggers/run flows, and `issues` labels + expanded read/mutation + approvals/work-products/document/checkout-release/interaction-decision/delete/create-interaction scope entry with pre-scope auth rejection checks.
- **Phase 1 / S1 Adapter + tenant provisioning**
  - `growthos_native` adapter contract scaffolded in `@growthos/adapter`.
  - Typed `PaperclipClient` implemented (company, agent, issue, checkout, release, wakeup operations).
  - Env-driven config parsing implemented (`PAPERCLIP_BASE_URL`, `PAPERCLIP_SERVICE_TOKEN`, `PAPERCLIP_TIMEOUT_MS`).
  - **`TenantProvisioningOrchestrator`** (`packages/core/src/tenant-provisioning.ts`): 5-step idempotent provisioning sequence — Paperclip company → Gitea workspace repo (from `growthos-ws-template`) → NATS consumer group (per-tenant filter subject) → MinIO bucket (`growthos-{tenantId}`) → seed `docs/FOUNDER.md`. Each step emits a `ProvisioningProgressReporter` event (10% → 30% → 55% → 70% → 85% → 100%). Typed client interfaces (`PaperclipProvisioningClient`, `GiteaProvisioningClient`, `NatsProvisioningClient`, `MinioProvisioningClient`) + stub implementations for testing. Naming helpers (`tenantBucketName`, `tenantWorkspaceRepoName`, `tenantNatsConsumerName`, `tenantNatsFilterSubject`). 19 unit tests covering full happy path, per-step skipping on `isNew=false`, error propagation.
- **Phase 1 / S2 Domain + skills**
  - Deterministic `Motion Engine` starter implemented in `@growthos/core` with versioned scorer output and tests.
  - **Handoff contracts v0** (`packages/core/src/handoff-contracts.ts`): 4 Zod schemas with versioned discriminant literals — `intel_brief.v1` (competitive + community signals + ranked opportunities), `content_opportunity.v1` (single scored opportunity with evidence array), `content_brief.v1` (full brief with 4+ outline sections, confidence score, CTA), `blog_draft.v1` (markdown body + claims array + quality indicators). `HANDOFF_CONTRACT_SCHEMAS` registry + `parseHandoffContract()` dispatcher. 22 unit tests covering validation, defaults, and dispatch.
  - **Skills library v0** (`packages/skills/library/`): 5 production-quality skill files with validated frontmatter — `base/founder_voice.md` (voice principles, vocabulary extraction, golden examples), `base/brand_rules.md` (positioning enforcement, claim constraints, tone matrix), `base/claims_handling.md` (stat/comparison/prediction/definition taxonomy, hard-stop phrases, verification workflow), `inbound/content_strategist.md` (full brief + draft construction procedure, quality gate, escalation rules), `intel/intel_director.md` (signal taxonomy with confidence thresholds, scan procedure, opportunity scoring, brief completeness gate). All parse cleanly through `skillFrontmatterSchema`.
- **Phase 1 API foundation**
  - API app factory + server bootstrap separation implemented.
  - Endpoints implemented:
    - `GET /health`
    - `POST /v1/motions/score`
    - `POST /v1/commands/outbox`
    - `POST /v1/paperclip/bootstrap-tenant`
  - `/v1/commands/outbox` now persists through the configured `OutboxRepository`; production resolves to Postgres via `DATABASE_URL`.
  - `Idempotency-Key` support implemented on tenant bootstrap route.
  - Centralized error mapping implemented (validation -> `400`, service unavailable -> `503`, fallback -> `500`).
- **Testing implemented as part of delivery**
  - Unit tests for motion scoring and adapter client.
  - Route-level API tests including bootstrap success/failure, idempotency behavior, validation error mapping, and fetch-mocked integration path.

### In progress / not yet implemented

- **Phase 0 / Track B** production data-plane provisioning (multi-node cluster topology — ClickHouse 3-node, Qdrant 3-node, Valkey 3-node, NATS 3-node) not yet wired; single-node dev stubs are live. Non-Postgres stores (ClickHouse/Valkey/MinIO/Meilisearch/Qdrant/Gitea) not yet seeded by `seed:dev` (require native clients). **Atlas** covers validate + lint + apply. **pgroll** workflow guide and scripts are complete; pgroll binary is an external install, not in CI (production deploy operation only).
- **Phase 0 / Track C** durable event/workflow plane (`NATS JetStream`, `Restate`, outbox publisher) is still incomplete at *production topology* level (multi-node clusters, stream topology from stack decisions, SigNoz tracing); code-path wiring is complete including `infra-smoke` optional Restate state verification. Outstanding: run smoke + callback worker against live stacks and harden Restate ingress to the documented `GET /workflows/tenant-provisioning/:workflowId/state` contract in your deployment.
- **Phase 0 / Track D** `@growthos/llm-harness` package complete (PromptTemplate, StubLlmCallRunner, OpenAiLlmCallRunner with OTel + retry). Remaining: `llm_call_logs` ClickHouse table + cost-tracking sink, prompt versioning in Postgres, LLM integration in workers (currently deterministic stubs).
- **Phase 0 / Track E** LLM gateway deployment, secrets, identity, billing, and GitOps deploy tracks not yet implemented.
- **Phase 0 / Track F** Paperclip fork strict RLS enforcement is not yet complete across all company-scoped routes; dashboard, goals, activity, inbox-dismissals, sidebar project preferences, sidebar-badges, user-profile, company-skills, costs/budget, environments, approvals, assets, projects list/get/create/update + workspace CRUD + runtime control, secrets, routines, and the current `issues` labels + expanded read/mutation (including approvals, work-products, documents, checkout/release, interaction decisions, delete/create-interaction, queued comment cancel, issue comment add/reopen flow DB paths, and scoped expired-interaction helper usage) batch are converted reference paths.
- **Phase 1 agents/workers/UI** (Intel/Inbound/Reporting, approval queue UI, weekly review) not yet implemented.

### Active next milestones (execution order)

1. **Track B groundwork**
   - ✅ `pnpm migrate:dry-run` — bootstrap + Drizzle migration via `pg`, CI-parity.
   - ✅ **Atlas `validate` + `lint`** — `drizzle/atlas.sum` + `ariga/setup-atlas@v0.3` in CI (v1.2.0).
   - ✅ **`pnpm migrate:apply`** — `atlas migrate apply --env growthos` (uses `DATABASE_URL` from `atlas.hcl` `getenv()`).
   - ✅ **`pnpm seed:dev`** — idempotent dev-tenant seed across `motion_scores`, `motion_stack`, `approval_feedback`, `event_outbox`, `workflow_runs`; optional NATS publish.
   - ✅ **Full Compose stack** — Valkey, MinIO (+`growthos` bucket init), ClickHouse (+`growthos` DB + `activity_log`/`cost_events`/`signal_attribution` DDL via `docker-entrypoint-initdb.d`), Meilisearch, **OpenBao 2.2** (dev mode, port 8200) all wired in `compose.yaml`.
   - ✅ **All 7 workers** wired with OTel SDK + pino structured logger (replaces all `console.*` calls per Principle 1.5); `OutboxPublisher` drain path has `outbox.publish_cycle` / `outbox.drain_tenant` spans + counters + histogram.
   - ✅ **Generated RLS invariant tests** — 15 cases (3 per table x 5 tables) auto-derived from `GROWTHOS_RLS_TABLE_SPECS`; owner/other/no-context verified against live Postgres; run with `DATABASE_URL=... pnpm --filter @growthos/db test`. **Wired into CI** (`rls-invariants` job on every PR).
   - ✅ **pgroll expand–contract workflow** — `WORKFLOW.md` guide + 2 example migrations + `migrate:expand/contract/rollback/status` scripts.
   - ✅ **Operational runbooks** — NATS leader loss, Postgres failover, OpenBao seal/unseal (`docs/runbooks/`).
   - ✅ **`playbook_versions` + `signal_events` tables** — Drizzle schema + migration `0001_narrow_lake.sql` + RLS policies + atlas.sum updated; 2 new RLS specs (21 total invariant cases).
   - ✅ **`PlaybookVersionsRepository`** — interface + `InMemoryPlaybookVersionsRepository` + `PostgresPlaybookVersionsRepository`; `getActive`, `listAll`, `create` (auto-version), `retire` (idempotent soft-retire); 11 unit tests.
   - ✅ **`SignalEventsRepository`** — interface + `InMemorySignalEventsRepository` + `PostgresSignalEventsRepository`; `ingest` (partial-unique dedup by externalId), `listUnprocessed`, `markProcessed`; 13 unit tests.
   - ✅ **`migrate-dry-run-cli`** applies all `drizzle/*.sql` in lexicographic order — new migrations auto-discovered; `GROWTHOS_MIGRATE_SQL` env override preserved; `CORE_TABLES` extended to 7 tables.
   - **Track B + data layer complete for Phase 0+.**
   - ✅ **`HttpGiteaProvisioningClient`** — native `fetch` against Gitea v1 REST API: `provisionWorkspaceRepo` (existence check → generate from template, 409 idempotency), `createOrUpdateFile` (SHA-based GET → POST/PUT upsert); `GiteaClientConfig` + `fromEnv()` factory.
   - ✅ **`HttpMinioProvisioningClient`** — `@aws-sdk/client-s3` with `forcePathStyle=true` for MinIO S3-compatible endpoint: `provisionBucket` (HeadBucket existence check → CreateBucket), `MinioClientConfig` + `fromEnv()` factory.
   - ✅ **`worker-workflow-callback` env-flag routing** — `ENABLE_REAL_GITEA_CLIENT=true` / `ENABLE_REAL_MINIO_CLIENT=true` selects HTTP vs stub per client independently; Paperclip and NATS remain stubs until their HTTP clients are built.
   - ✅ **16 HTTP client tests** — Gitea: provisionWorkspaceRepo (create, idempotent, 409 race, 500 error), createOrUpdateFile (create, update, 422 error); MinIO: provision (create, exists, AccessDenied, 404); fromEnv: Gitea (missing URL, missing token, valid), MinIO (missing endpoint, valid).
   - ✅ **`@growthos/llm-harness`** — `PromptTemplate` + `definePrompt()` factory; `LlmCallRunner` interface; `StubLlmCallRunner` (per-template responses, call history, reset); `OpenAiLlmCallRunner` (retry w/ exponential backoff on 429/5xx, OTel `llm.chat.completions` span, per-model cost estimation, prompt-cache detection, `fromEnv()` factory); 4 built-in prompt templates (`intel-brief.generate`, `content-brief.generate`, `blog-draft.generate`, `critique.evaluate`); 24 unit tests.
   - ✅ **Critique→Learning→Playbook feedback loop** — `LearningWorker.processFromCritique()` consumes `critique.completed.v1`, loads existing active playbook, appends corrective rubric criteria from failure reasons via `buildUpdatedRubricContent()`, creates new `PlaybookVersionRecord`, emits `learning.playbook.updated.v1`; NATS `t.*.critique.completed.v1` subscription wired in `worker-learning/src/index.ts`; 10 new playbook-path tests (22 total).
   - ✅ **Seed dev playbooks** — `seed-dev-cli.ts` idempotently seeds `blog_draft` rubric (5 criteria: has_cta, has_evidence, no_forbidden, length_ok, has_headings; forbidden_phrases list; 300–3000 word range) and `content_brief` rubric (4 criteria: has_hook, has_evidence, has_cta, length_ok; 150–1000 word range) for the dev tenant — closes local dev end-to-end Critique→Learning loop.
   - ✅ **`llm_call_logs` ClickHouse table + `LlmCallLogSink`** — `llm_call_logs` DDL added to `001_init.sql` (tenant_id, prompt_id, prompt_version, model, tokens, latency_ms, cost_usd, cached, 24-month TTL); `LlmCallLogSink` interface + `NoopLlmCallLogSink` + `ClickHouseLlmCallLogSink` (HTTP JSONEachRow, auth, error-swallowing) + `BufferedLlmCallLogSink` (max-batch + auto-flush timer, prefers `insertRows()` batch method); `buildLogRow()` factory; wired as optional `logSink` dep into `OpenAiLlmCallRunner`; 16 new unit tests (40 total in harness).
   - ✅ **`POST /v1/signals` signal ingest** — Hono route validates `signalType` (6-value enum), `source`, optional `externalId` + `payload`; reads `X-Tenant-Id` header; calls `SignalEventsRepository.ingest()` (idempotent); returns `{ inserted, signalId }`; 5 API tests (valid, duplicate, missing header, invalid type, no DB).
   - ✅ **Approval queue API** — `GET /v1/approvals` (filter by `outputType`, `limit`; reads `OutboxRepository.listUnconsumed()`) + `POST /v1/approvals/decide` (records founder decision via new `ApprovalFeedbackRepository`); `ApprovalFeedbackRepository` interface + `InMemoryApprovalFeedbackRepository` + `PostgresApprovalFeedbackRepository` (`@growthos/db`); 6 API tests; total API tests: 34.
   - ✅ **`@growthos/web` Next.js 15 UI starter** — App Router; Tailwind CSS 3 + Inter; Approval Queue page (Server Component + Server Actions: approve/reject per-draft with quality indicators + reviewer note field); Motion Stack page (score grid, scorer metadata, input summary); Signal Ingest page (Client Component: 6 signal types, source/externalId/note fields, dedup feedback); typed `ApiClient` with Zod-validated responses; `apps/web` in `pnpm` workspace; `next start --port 3088`.
   - **Next milestones:** Phase 0 / Track D remaining 20%: `OpenAiLlmCallRunner` — pass `tenantId` from call context to log sink; Phase 1 / S2 Motion Engine `motion-scorer` upgrade to LLM-graded signals; Phase 1 / S5 completion: session/auth, real data fetch (GET /v1/motion), weekly review page; Phase 0 / Track E (Identity/billing/secrets/deploy).

2. **Operational smoke runs** — `pnpm infra:up` then `pnpm migrate:dry-run` / `pnpm seed:dev` / `pnpm smoke:infra` against Compose Postgres (**5488**) + NATS (**4228**); with Restate: add `RESTATE_BASE_URL` + `GROWTHOS_SMOKE_WORKFLOW_ID`.
3. **Outbox drain e2e** — `pnpm smoke:infra` runs **`OutboxPublisher` + `NatsJetStreamPublisher`** from `worker-outbox-publisher`, asserts consumed, verifies JetStream `last_by_subj`. Full polling worker against live traffic is a separate op check.
4. Continue Paperclip fork final verification pass for residual unscoped `issues` branches.

---

## 3. Phase 0 — Foundations (weeks −2 → 0)

**Goal:** every infrastructure component a future engineer will rely on exists, is observable, and has a runbook. No domain code yet.

### 3.1 Tracks (run in parallel with 2 engineers)

#### Track A — Repo + tooling
- Monorepo: **pnpm + Turborepo + Biome + Vitest + tsconfig-base**.
- Packages scaffolded: `@growthos/core`, `@growthos/api`, `@growthos/adapter`, `@growthos/skills`, `@growthos/design-system`, `@growthos/test-utils`.
- CI on GitHub Actions: lint, typecheck, unit, RLS suite (empty stub), migration dry-run, Turbo remote cache via R2.
- Branch protection: PRs require green CI + 1 review + linear history.
- **Definition of done:** new engineer can clone, `pnpm install`, `pnpm dev`, see hot-reloading in <60s.

#### Track B — Data plane
- **Postgres 16** with `pgvector`, `pg_partman`, `pgcrypto`, `pgaudit`. RLS-by-default migration baseline.
- **Drizzle ORM** + **Atlas** for migrations. **pgroll** wired for zero-downtime changes.
- **ClickHouse** cluster (3 nodes) with replication; `growthos.activity_log`, `growthos.cost_events` tables stubbed.
- **Qdrant** cluster (3 nodes) with API tokens per environment.
- **Meilisearch** single-node for v0; clusterable later.
- **MinIO** with per-tenant bucket convention.
- **Valkey** cluster (3 nodes) for cache only.
- **Gitea** with API token-based provisioning + per-tenant repo template `growthos-ws-template`.
- **Definition of done:** `seed dev` script provisions a fake tenant across all stores in <30s.

#### Track C — Event + workflow plane
- **NATS JetStream** cluster (3 nodes) with subjects + streams configured per the topology in `Growthos_v4_Stack_Decisions.md` §6.
- Per-tenant subject prefixes enforced via NATS account scoping.
- **Restate** server self-hosted; TS SDK wired in `@growthos/core/workflows`.
- **outbox-publisher** (Rust) skeleton: reads Postgres NOTIFY, publishes to JetStream, leader-elected via JetStream KV.
- **Definition of done:** a hello-world Restate workflow triggered by an HTTP POST writes to outbox → JetStream → consumer → ClickHouse, end-to-end traced in SigNoz.

#### Track D — LLM + agent harness
- **LiteLLM proxy** self-hosted with Anthropic + OpenAI keys, per-tenant key scoping.
- **Langfuse** self-hosted, OTel exporter wired.
- **Promptfoo** in CI with a 10-prompt smoke set.
- **SmarterMCP** deployed in dev; tenant + tool-pack provisioning scripts working.
- **Daytona** (or E2B) sandbox provisioning script.
- **Definition of done:** a CLI script can open a SmarterMCP session, run one tool call (search), get a response logged in Langfuse + SigNoz with a joined trace.

#### Track E — Identity, billing, secrets, deploy
- **Zitadel** deployed; org-per-tenant model defined.
- **Lago** deployed; pricing plan stubs (motion-active, approved-action) defined.
- **OpenBao** deployed; KMS envelope encryption wrapper for per-tenant secrets.
- **K3s** cluster (or Coolify if v1 founder budget tight); **Argo CD** + **Argo Rollouts** wired.
- **Pulumi/OpenTofu** repo with the full cluster definition.
- **GlitchTip** + **SigNoz** + **Grafana** receiving from OTel collector.
- **Definition of done:** `pulumi up` creates a fresh environment from zero in <30 minutes.

#### Track F — Paperclip fork
- Fork pulled, `growthos/` branch convention established.
- RLS migration drafted and applied to all Paperclip tables (additive).
- BullMQ scheduler PR drafted, Restate adapter PR drafted (do not merge yet — Phase 1 picks the winner).
- LiveEventsServer replaced with NATS-backed `RedisPubSubBackedSubscriptionRegistry` swap.
- Upstream-sync workflow wired (weekly cron, triage doc template).
- **Definition of done:** forked Paperclip running locally with RLS enabled, all integration tests passing, weekly upstream-sync rehearsed once.

### 3.2 Phase 0 exit criteria (all must pass)

- [ ] `make e2e-smoke` runs end-to-end: provisions a tenant, runs a no-op heartbeat through Paperclip + SmarterMCP, writes an event to NATS, indexes in ClickHouse, surfaces in SigNoz trace, all under one OTel trace ID.
- [ ] RLS suite (generated, ~20 tests against stub tables) passes on every PR.
- [ ] One full deploy via Argo CD with rollback rehearsal.
- [ ] Runbook doc exists for: NATS leader loss, Postgres failover, Restate crash, SmarterMCP outage, OpenBao seal/unseal.

---

## 4. Phase 1 — Trustworthy compression (weeks 1 → 10)

**Goal:** a real founder onboards, gets motions scored, sees Inbound Content Strategist + Reporting Director produce real outputs that get approved through a tier-aware queue, and the loop captures `approval_feedback` rows ready to feed Learning Director (which lands in Phase 2).

**Headcount assumed:** 2 engineers + 1 designer. Tighter, smaller scope.

### 4.1 Sprint plan

| Sprint (2w) | Track | Deliverable |
|---|---|---|
| S1 | Adapter | `growthos_native` Paperclip adapter scaffolding. Pulls agent context, opens SmarterMCP session, runs ReAct loop with one stub agent. Writes outputs back to Paperclip issue documents. Emits cost_events. |
| S1 | Domain | Tenant provisioning Restate workflow: Zitadel org → Paperclip company → Gitea repo from template → NATS subjects → MinIO bucket → seed `FOUNDER.md`. Idempotent. |
| S2 | Domain | Motion Engine v1: scorer (deterministic, version-stamped), stack selector, agent resolver, skills resolver. Skill manifest format finalized; skills library v0 (5 files) seeded. |
| S2 | UI | Design system v0: tokens, primitives, command-menu, layout shell. Storybook + Chromatic in CI. Onboarding wizard skeleton (5 steps, no real forms yet). |
| S3 | Agents | Intel Director agent: daily routine + signal-event reactive. Reads CRM mirror + competitor scrape + community sweeps. Produces `intel_brief.v1`. |
| S3 | Agents | Reporting Director agent: weekly routine. Produces `weekly_review.v1` from cost_events + activity_log + approval_feedback. |
| S4 | Agents | Inbound Content Strategist agent: produces `content_brief.v1` (P0) and `blog_draft.v1` (P2). Handoff contract from Intel Director wired. |
| S4 | Domain | Confidence Scorer fast-path (in-process library) + critique async worker. Risk tier resolver. Output rubrics stored as `playbook_versions` rows. |
| S5 | UI | Approval queue v1: TanStack Table + Virtual, TipTap diff editor, cmdk command menu, keyboard nav (`j/k/a/e/x/⌘⏎`). Risk-tier grouping, evidence sidebar, edit-distance capture. |
| S5 | Domain | `approval_feedback` pipeline complete: edit_distance, rubric_failures, learn_opt_in. Emits `output.approved`/`output.rejected` events. |
| S6 | Product | Onboarding wizard polish (real forms, progress, motion-score reveal). Founder digest v1. Weekly operating review surface. Settings (connections, brand assets, policy preferences). |

### 4.2 Cross-cutting Phase 1 work

- **Skills library v0** (5 files): `base/founder_voice.md`, `base/brand_rules.md`, `base/claims_handling.md`, `inbound/content_strategist.md`, `intel/intel_director.md`. Each ships with frontmatter + mission + how-to + output contract + golden examples.
- **Handoff contracts v0**: `content_opportunity.v1`, `intel_brief.v1`, `content_brief.v1`, `blog_draft.v1`. JSON-Schema + Zod, contract tests in CI.
- **MCP tools owned by us**: `growthosFileRead`, `growthosFileWrite`, `growthosSkillLoad`, `growthosMemoryQuery`, `growthosClaimVerify`, `growthosEvidencePin`. All schema-validated.
- **Observability**: dashboards for heartbeat success rate, cost/tenant/day, approval-queue depth, signal-classify latency, RLS enforcement rate (target: 100%).

### 4.3 Phase 1 exit criteria (all must pass with one real bench tenant)

- [ ] Onboarding completes in <10 minutes for a new founder.
- [ ] Motion scores presented with rationale and source evidence.
- [ ] Three agents (Intel, Inbound, Reporting) running on routines + on-demand wakeups.
- [ ] Approval queue shows real items with confidence + risk tier + evidence + diff editor; `approval_feedback` rows being written.
- [ ] Weekly review generated automatically Sunday 22:00 local.
- [ ] Founder digest delivered daily/weekly via Postal.
- [ ] All Phase 0 invariants still hold: RLS green, OTel traces complete, cost <$300/tenant/month at the bench tenant.
- [ ] No P0 or P1 bug open >48h.

---

## 5. Phase 2 — Compounding value (weeks 11 → 20)

**Goal:** the loop closes. Experiments propose, run, conclude. Learnings get synthesized, validated, approved, and bump playbook versions. Subsequent agent outputs measurably improve. Signal Router goes real-time. Warm outbound, GEO, lifecycle activate.

**Headcount:** scale to 4 engineers + 1 designer + 1 part-time data/ML.

### 5.1 Sprint plan

| Sprint (2w) | Track | Deliverable |
|---|---|---|
| S7 | Performance | **Signal Router in Rust**. Webhook ingest (HubSpot, Stripe, Intercom, custom), stage-1 rule classifier, stage-2 LLM classifier, urgency + half-life + dispatch. Replaces any v1 stub. |
| S7 | Domain | Experiment Manager: variant proposal → approval → running → evaluation (GrowthBook stats engine) → promotion → `playbook_versions` bump. Anti-poisoning guards (segment balance, anomaly windows). |
| S8 | Domain | Learning Director pipeline: ingester → evidence aggregator → candidate synthesizer → validator → playbook proposal → approval gate → activation. Revalidation cron. |
| S8 | UI | Experiment dashboard, Learning proposal review surface (diff view + evidence + approve/reject/defer). |
| S9 | Agents | Warm Outbound Researcher + Warmth Builder + warmth-gate execution-policy stage. Per-prospect warmth score; cold-override path. |
| S9 | Agents | Community Operator (read-only first; reply drafts gated to founder approval until trust unlocked). |
| S10 | Agents | GEO Monitor + GEO-aware inbound sub-skill. Citation tracking dashboard. |
| S10 | Agents + Domain | Lifecycle Operator + Lifecycle Engine (deterministic stage machine). Activation, save-play, expansion-intro flows. |

### 5.2 Cross-cutting Phase 2 work

- **Auto-approve maturation**: after 30 outputs in a (type, tier) with ≥27 approved + 0 rejected, founder can unlock auto-approve. Even unlocked, 5–10% sampled to humans.
- **Skills library v1**: full motion coverage (12–15 files), all with golden examples and structured rubrics.
- **Calibration job** (daily): predicted confidence vs observed approval rate, bucketed; alerts if drift > 10pp for 3 days.
- **Replay tooling**: CLI `growthos replay --tenant X --from 2026-04-01 --through 2026-04-08 --pipeline learning` reruns Learning Director against historical events.

### 5.3 Phase 2 exit criteria

- [ ] At least one tenant has run an experiment to conclusion, had its winner promoted, and produced subsequent outputs measurably better against the winning skill version.
- [ ] Learning decay + revalidation cycle running weekly without manual intervention.
- [ ] Signal-to-dispatch p95 < 60s under load (Rust router validated at 100 tenants × 10 sig/s).
- [ ] Confidence calibration drift < 10pp across all tiers for 30 consecutive days.
- [ ] Cost/tenant/month tracked and reported; outliers (>3× median) auto-flagged.
- [ ] Auto-approve unlocked for at least one (type, tier) on the bench tenant, with zero negative incidents in a rolling 30 days.

---

## 6. Phase 3 — Operating leverage (weeks 21 → 32+)

**Goal:** the system stops being a single-founder tool and becomes a multi-user, multi-motion, segment-aware platform that an enterprise GTM team can adopt.

### 6.1 Workstreams (parallel, no rigid sprint order)

- **Multi-user workspaces**: roles (founder, operator, reviewer, viewer), per-role approval routing, per-tenant Zitadel project + role mappings.
- **ABM Planner, Customer Expansion Analyst, Launch Orchestrator** agents.
- **Segment benchmark priors**: cross-tenant aggregation pipeline with N≥5 minimum, anonymization enforced structurally, opt-in per tenant.
- **Revenue Leak Investigator**: scheduled deep-dive into deal stage drop-off, content gaps, lifecycle leakage.
- **Path attribution**: not models — show the raw multi-touch path and let the user interpret. Add "what's missing" detection.
- **Partner co-selling/co-marketing**: partner discovery agent + outreach brief flow + co-marketing artifact templates.
- **Enterprise hardening**: SSO via OIDC, audit export, SOC2/ISO scoping, custom DLP rules per tenant, custom claims library imports.

### 6.2 Phase 3 exit criteria

- [ ] Three+ multi-user tenants in production with role-based approvals working.
- [ ] At least one segment-level prior published (anonymized), informing recommendations on at least 5 tenants.
- [ ] Audit export passes a third-party security review.
- [ ] First enterprise contract signed with custom policy bundle.

---

## 7. Definition of Done — module checklist

Every domain or platform module ships with all of these. PRs missing any item are rejected.

```
[ ] Spec doc (1-2 pages) committed alongside code
[ ] Zod schemas for inputs, outputs, events, persistent rows
[ ] Unit tests, ≥85% line coverage on domain code, 100% on policy/scoring
[ ] Contract tests for every schema (positive + negative + unknown-field)
[ ] Integration tests with Testcontainers for every cross-service seam
[ ] RLS tests if module touches a tenant-scoped table
[ ] OTel spans on public boundary; correlated with Langfuse if LLM-touched
[ ] Three Prometheus metrics minimum (rate, error, duration)
[ ] Runbook entry: how to debug a stuck/failing case
[ ] Migration is expand-contract, dry-run on shadow DB green
[ ] Feature flag for rollout; flag has expiration date
[ ] Cost impact estimated and tracked for one week post-launch
[ ] Latency budget defined and asserted in perf test
[ ] Storybook story for any new UI component
```

---

## 8. Team + ownership

### 8.1 Minimum viable team for Phase 1

| Role | Headcount | Owns |
|---|---|---|
| Platform engineer | 1 | Paperclip fork, Restate, NATS, deploy, observability |
| Domain engineer | 1 | Motion Engine, agents, adapter, MCP tools |
| Designer / front-end | 1 | Design system, approval queue, onboarding, founder surfaces |
| Founder | 1 | Skills library content, founder voice samples, approval rubric, bench-tenant operator |

### 8.2 Phase 2 expansion

| Role | Headcount | Adds |
|---|---|---|
| Performance engineer | 1 | Signal Router (Rust), outbox-publisher (Rust), perf budgets |
| ML/data engineer (part-time) | 0.5 | Calibration jobs, learning validator, replay tooling |
| Front-end engineer | +1 | Experiment dashboard, learning UI, GEO surface |

### 8.3 Phase 3 expansion

| Role | Headcount | Adds |
|---|---|---|
| Security/compliance lead | 1 | Audit, SOC2, enterprise SSO, custom DLP |
| Data engineer | 1 | Segment priors pipeline, ClickHouse capacity, attribution |
| Customer engineer | 1 | Tenant onboarding, custom claims import, escalation |

---

## 9. Critical path + risk hotspots

### 9.1 Critical path (do not block)

```
Phase 0 Track F (Paperclip fork + RLS)
  → Phase 1 S1 (adapter + tenant provisioning)
    → Phase 1 S2 (Motion Engine)
      → Phase 1 S3-4 (agents)
        → Phase 1 S5 (approval queue)
          → Phase 1 S6 (founder surfaces)
            ⇒ Phase 1 EXIT
```

Anything off this path can slip a sprint without delaying Phase 1 exit.

### 9.2 Risk hotspots

| Risk | Owner | Mitigation |
|---|---|---|
| Paperclip upstream breaks RLS PR | Platform | RLS as orthogonal column+policies layer; weekly sync rehearsal in Phase 0 |
| Adapter ReAct loop costs blow up | Domain | Per-run budget cap in SmarterMCP session; cost_events alerted at >$5/run |
| Approval queue feels generic | Designer | Weekly UX critique with Linear/Raycast as rubric; Storybook visual diff in CI |
| Confidence scoring uncalibrated → founder distrust | Domain + ML | Daily calibration job from Phase 1; conservative auto-approve unlock |
| Learning Director proposes bad changes | Domain | Hard approval gate + revalidation + rollback any playbook version in one SQL |
| NATS misconfigured at scale | Platform | Phase 0 includes 1k subj × 100 msg/s sustained load test |
| Skills library quality drift | Founder | Skills library has its own PR review checklist; golden-output regression in CI |
| Tenant secrets leak in logs | Platform | Log scrubber middleware + secret-detection CI check + GlitchTip PII filters |

---

## 10. Cost + performance budgets (asserted in CI)

### 10.1 Per-tenant monthly cost ceiling (Phase 1)

| Line | Budget | Hard cap |
|---|---|---|
| LLM (producer + critic + classifier) | $150 | $300 (auto-pause) |
| Third-party data | $80 | $150 |
| Infra amortized share | $15 | $30 |
| External send | $30 | $60 |
| **Total COGS** | **$275** | **$540** |

### 10.2 Latency budgets (per surface)

| Surface | p95 | Test |
|---|---|---|
| API mutation handler return | 200ms | Vitest+k6 in CI |
| Approval queue page load | 300ms | Playwright + Lighthouse in CI |
| Heartbeat run completion | 30s | Integration test |
| Self-critique completion | 15s | Integration test |
| Signal → first dispatch (P0) | 60s | Load test, nightly |
| Outbox commit → WS delivered | 200ms | Integration test |
| Learning replay (90d, one tenant) | 5min | Nightly job, alerts on regression |

### 10.3 Throughput budgets (per cluster, Phase 2)

| Component | Sustained | Burst |
|---|---|---|
| Webhook ingest | 1k/s | 10k/s for 60s |
| Heartbeat runs | 100/s | 500/s for 30s |
| Critique queue | 50/s | 200/s for 30s |
| Outbox publish | 5k/s | 20k/s for 60s |
| WS broadcasts | 10k/s | 50k/s for 30s |

CI runs scaled-down versions; nightly load tests assert full numbers.

---

## 11. Quality gates

### 11.1 Per-PR (blocking, <10 min)

- Lint + typecheck + Biome format
- Unit tests
- Contract tests
- RLS suite (generated)
- Smoke integration suite (~20 tests)
- Migration dry-run on shadow DB
- Redis-key/NATS-subject/Gitea-path prefix linter
- Storybook visual diff (UI changes only)
- Bundle-size check (UI changes only)

### 11.2 Pre-merge to main (blocking, <25 min)

- Full integration suite
- Security suite
- E2E full-loop test (Appendix B from tech spec)
- Mutation tests on policy/scoring code (Stryker)

### 11.3 Nightly (non-blocking, paged on repeated failure)

- Load suite (six scenarios)
- SmarterMCP contract test against staging
- Promptfoo eval suite + Langfuse dataset replay
- Calibration + decay + claim-freshness jobs
- Cross-tenant red-team probe

### 11.4 Weekly (blocking weekly release)

- Chaos suite (eight scenarios)
- Playbook-diff quality eval
- Cost-per-approved-action audit

---

## 12. Release cadence

- **Trunk-based development**: every PR merges to `main`. No long-lived branches.
- **Continuous deployment** to staging on every merge.
- **Production releases** Tuesday + Thursday morning, behind feature flags.
- **Hotfixes**: same-day, behind a `hotfix/*` branch with a 2-engineer review.
- **No deploys Friday afternoon, weekends, or week of US Thanksgiving / EU summer.**

---

## 13. What "done" looks like at the end of Phase 1

A demo a founder cares about, not a checklist:

> Avery (founder of Lattice, devtools, ACV $12k) signs up Monday at 9am.
> By 9:15am she has motion scores and a confirmed inbound + community + lifecycle stack.
> At 9:18am Intel Director runs its first sweep, drafts an opportunity brief about a competitor's pricing change.
> At 9:22am the Inbound Content Strategist drafts a comparison blog with cited claims.
> By 9:25am the draft is in her approval queue with confidence 0.76, risk P2, three pieces of evidence linked.
> She edits 12% of the copy, approves with one keystroke, and the draft publishes to Webflow at 9:31am.
> Sunday evening she gets a weekly review email with three approved actions, two pending, one learning candidate ready for review.
> She trusts what she saw enough to come back next Monday.

If that demo holds, Phase 1 is done. If any one of those moments feels generic, slow, or uncanny, Phase 1 is not done.

---

## 14. What this plan is *not*

- It is not a Gantt chart. Sprints can shift; exit criteria cannot.
- It is not a hiring plan. Phase 1 with 2 engineers is realistic only if scope discipline holds.
- It is not a marketing plan. The wedge depends on real founder use, not landing pages.
- It is not an excuse to widen v1. Every "wouldn't it be nice" idea goes in a Phase 3 backlog file, not in the current sprint.

---
