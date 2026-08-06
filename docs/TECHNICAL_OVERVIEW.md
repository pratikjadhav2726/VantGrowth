# GrowthOS — Technical Overview

**Version:** 4.0  
**Status:** Living document — reflects current implementation state  
**Audience:** Engineers onboarding to the codebase, contributors, deployment operators

---

## Table of Contents

1. [What GrowthOS Is](#1-what-growthos-is)
2. [Can It Run?](#2-can-it-run)
3. [How to Run](#3-how-to-run)
4. [Repository Layout](#4-repository-layout)
5. [End-to-End Data Flow](#5-end-to-end-data-flow)
6. [Apps](#6-apps)
7. [Workers](#7-workers)
8. [Packages](#8-packages)
9. [Database Schema](#9-database-schema)
10. [Authentication & Authorization](#10-authentication--authorization)
11. [Event Outbox Pattern](#11-event-outbox-pattern)
12. [Environment Variables](#12-environment-variables)
13. [Docker & Infrastructure](#13-docker--infrastructure)
14. [Implementation Status](#14-implementation-status)
15. [Production Readiness Checklist](#15-production-readiness-checklist)

---

## 1. What GrowthOS Is

GrowthOS is a **self-hostable GTM operating system** for early-stage startups. It replaces 6–10 GTM hires with an agentic pipeline that:

- Ingests signals (market, competitor, product, customer)
- Scores and routes them through a motion stack
- Generates content drafts (blog, outreach, briefs) via LLM workers
- Runs AI critique against versioned playbooks
- Surfaces an approval queue for founder review
- Delivers a weekly digest summarising what shipped, what was rejected, and what the pipeline learned

The system is **multi-tenant**, **asynchronous**, and **auditable** — every state transition is written to a transactional outbox before being published to NATS JetStream.

---

## 2. Can It Run?

The repository contains the application, workers, migrations, and Compose
configuration required for the local stack. This document is a capability map,
not a record that a Docker runtime has been started successfully in a particular
environment.

| Area | Current implementation / operator action |
|---|---|
| Docker Compose development stack | Checked-in configuration; validate and start it with the [adaptive runtime runbook](runbooks/adaptive-gtm-local-runtime.md). |
| Database migrations | The `migrate` Compose service runs pending migrations and the dev seed before dependent application services start; inspect its logs after startup. |
| Durable worker path | The signal router, outbox publisher, content pipeline, critique, learning, attribution, and warmth workers have checked-in durable runtime entrypoints. |
| LLM availability | Intel, content, blog, and critique workers have deterministic fallbacks when `OPENAI_API_KEY` is absent. |

Email delivery (Postal), OpenAI-backed generation, Restate orchestration, and
Zitadel identity require external configuration. Missing configuration is a
restricted/degraded mode, not evidence that those production integrations work.

---

## 3. How to Run

### Docker (recommended)

```bash
cp .env.example .env
docker compose -f compose.dev.yaml config --quiet
docker compose -f compose.dev.yaml up --build -d
docker compose -f compose.dev.yaml ps   # verify all services healthy
```

| Service | URL |
|---|---|
| Web (Next.js) | http://localhost:3080 |
| API (Hono) | http://localhost:3091 |
| API health | http://localhost:3091/health |
| NATS monitoring | http://localhost:8222 |
| MinIO console | http://localhost:9001 |
| ClickHouse | http://localhost:8123 |

**Default login:**
- Email: any valid email
- Password: `growthos-dev-admin` (or `GROWTHOS_WEB_ADMIN_PASSWORD` if set)

### Local pnpm (no Docker)

Requires Postgres and NATS running externally.

```bash
pnpm install
pnpm dev
```

- Web: http://localhost:3088
- API: http://localhost:3001

For a signal-to-approval operator exercise and control-plane/dead-letter
checks, use the [adaptive runtime runbook](runbooks/adaptive-gtm-local-runtime.md).

### Running workers individually

Each worker is a standalone process:

```bash
pnpm --filter worker-intel-director dev
pnpm --filter worker-signal-router dev
pnpm --filter worker-outbox-publisher dev
# etc.
```

---

## 4. Repository Layout

```
growthos/
├── apps/
│   ├── api/                    # Hono REST API (port 3001)
│   ├── web/                    # Next.js 15 founder console (port 3000)
│   ├── infra-smoke/            # Infrastructure smoke tests
│   ├── worker-signal-router/
│   ├── worker-intel-director/
│   ├── worker-content-strategist/
│   ├── worker-blog-draft/
│   ├── worker-critique/
│   ├── worker-learning/
│   ├── worker-warmth/
│   ├── worker-attribution/
│   ├── worker-workflow-callback/
│   └── worker-outbox-publisher/
├── packages/
│   ├── db/                     # Drizzle schema, migrations, repositories
│   ├── core/                   # Motion scoring, handoff contracts, Restate client
│   ├── llm-harness/            # OpenAI runner, prompt templates, ClickHouse logging
│   ├── adapter/                # Paperclip HTTP client
│   ├── observability/          # OpenTelemetry middleware + logger
│   ├── identity/               # Zitadel client (stub in dev)
│   ├── billing/                # Lago billing client (stub in dev)
│   ├── secrets/                # Vault/OpenBao integration
│   ├── skills/                 # Agent skill registry parser
│   ├── design-system/          # UI component library (stub)
│   ├── test-utils/             # Vitest helpers
│   └── paperclip-client/       # Empty — not implemented
├── deploy/
│   ├── gitops/
│   │   ├── k8s/base/           # Kustomize manifests (api, web, cronjobs)
│   │   └── argo-cd/            # ArgoCD Application manifests
│   └── pulumi/                 # Pulumi IaC (TypeScript, incomplete stub)
├── docker/                     # Dockerfiles for each app
├── docs/                       # This file + runbooks + system design
├── compose.dev.yaml            # Full dev stack
├── compose.yaml                # Production compose
├── turbo.json                  # Turbo build pipeline
└── pnpm-workspace.yaml         # Monorepo workspace config
```

---

## 5. End-to-End Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│  SIGNAL INGESTION                                                   │
│                                                                     │
│  External source / API client                                       │
│      │                                                              │
│      ▼                                                              │
│  POST /v1/signals  (apps/api/src/routes/signals.ts)                 │
│      │  Zod validation → SignalEventsRepository.ingest()            │
│      │  Writes to signal_events (deduplicated by externalId)        │
│      ▼                                                              │
│  Durable signal_events inbox                                        │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  SIGNAL ROUTER                                                      │
│                                                                     │
│  worker-signal-router claims leased signal_events rows             │
│      │  Routes each signal and writes its command to event_outbox   │
│      │  Marks the inbox row processed after the handoff is durable  │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  OUTBOX PUBLISHER                                                   │
│                                                                     │
│  worker-outbox-publisher                                            │
│      │  Polls/listens for event_outbox WHERE consumedAt IS NULL     │
│      │  Publishes to NATS JetStream subject                         │
│      │  Sets consumedAt once published                              │
└────────────────────────────┬────────────────────────────────────────┘
                             │ JetStream: t.<tenant>.intel_brief.requested.v1
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  WORKER PIPELINE                                                    │
│                                                                     │
│  worker-intel-director                                              │
│      ├── If OPENAI_API_KEY set: LLM structured prompt               │
│      └── Fallback: generateDeterministicBrief() (always works)      │
│      Emits: intel_brief.v1                                          │
│                             │                                       │
│  worker-content-strategist  ◄────────────────────────────────────── │
│      │  Generates content brief from intel                          │
│      │  Emits: content_brief.v1                                     │
│                             │                                       │
│  worker-blog-draft          ◄────────────────────────────────────── │
│      │  Generates blog draft from content brief                     │
│      │  Emits: blog_draft.v1                                        │
│                             │                                       │
│  worker-critique            ◄────────────────────────────────────── │
│      │  Loads current PlaybookVersion rubric                        │
│      │  Evaluates draft → approve / revise / reject                 │
│      │  Emits: critique.completed.v1                                │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  FOUNDER REVIEW                                                     │
│                                                                     │
│  Web UI: /approvals                                                 │
│      GET /v1/approvals  → lists pending artifact outbox events      │
│      Founder reviews AI output                                      │
│      POST /v1/approvals/decide                                      │
│          → approve / edited_then_approved / rejected                │
│          → atomically writes approval_feedback + learning signal    │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  LEARNING CONTROL PLANE                                             │
│                                                                     │
│  worker-learning consumes critique.completed.v1 and learning.signal │
│      │  Persists evidence-gated proposals                            │
│      └── Re-checks evidence after proposal approval before promotion│
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  WEEKLY DIGEST                                                      │
│                                                                     │
│  GET /v1/digest/weekly                                              │
│      Aggregates: approval stats (7d), motion stack, signal counts   │
│                                                                     │
│  POST /v1/digest/send                                               │
│      If Postal configured: sends email                              │
│      If not: returns { sent: false, reason: "postal_not_configured"}│
│                                                                     │
│  K8s CronJob: deploy/gitops/k8s/base/cronjob-weekly-digest.yaml     │
└─────────────────────────────────────────────────────────────────────┘
```

### Signal routing side-channel

```
signal_events row created
    │
    ▼
worker-signal-router (leased Postgres inbox poll)
    ├── Applies the routing decision and preserves optional experiment lineage
    ├── Writes an idempotent downstream command to event_outbox
    └── Marks the signal processed only after that durable handoff
```

---

## 6. Apps

### `apps/api` — Hono REST API

Entry: `apps/api/src/index.ts`  
Port: `3001`

| Route group | Prefix | Auth required |
|---|---|---|
| Health | `GET /health` | No |
| Motions | `/v1/motions` | Bearer token (mutations) |
| Approvals | `/v1/approvals` | No (GET public, POST bearer) |
| Signals | `/v1/signals` | Bearer token |
| Digest | `/v1/digest` | Bearer token |
| Workflows | `/v1/workflows` | Bearer token |
| Commands | `/v1/commands` | Bearer token |
| Paperclip | `/v1/paperclip` | Bearer token |
| Settings | `/v1/settings` | Bearer token |

**Auth middleware** (`apps/api/src/auth-middleware.ts`): When `GROWTHOS_API_SERVICE_TOKEN` is unset, the API runs in permissive mode (all requests pass). This is the default in dev.

### `apps/web` — Next.js 15 Founder Console

Entry: `apps/web/src/app/`  
Port: `3000`

| Page | Route | Purpose |
|---|---|---|
| Login | `/login` | Session auth |
| Onboarding | `/onboarding` | First-run setup wizard |
| Approvals | `/approvals` | Review AI-generated drafts |
| Motion scoring | `/motion` | View and manage motion stack |
| Signals | `/signals` | Browse ingested signals |
| Weekly review | `/weekly-review` | Past-week summary |
| Digest | `/digest` | Digest preview + send |
| Settings | `/settings` | Tenant configuration |

**Session middleware** (`apps/web/src/middleware.ts`): All routes except `/login`, `/_next`, `/favicon` require a valid session cookie.

### `apps/infra-smoke`

Smoke tests that validate infrastructure connectivity (Postgres, NATS, MinIO, etc.) independently of application logic.

---

## 7. Workers

Workers are standalone Node.js processes and use only the dependencies required
for their role. Durable message consumers read from JetStream; the signal router
uses the Postgres `signal_events` inbox, and downstream handoffs return through
the transactional outbox.

| Worker | Trigger | What it does | Status |
|---|---|---|---|
| `worker-outbox-publisher` | Postgres outbox poll + LISTEN/NOTIFY | Sole runtime publisher to JetStream; marks delivered events and materializes sanitized dead-letter incidents | ✅ Durable path |
| `worker-signal-router` | Leased Postgres `signal_events` inbox poll | Routes signals and writes idempotent downstream commands to the outbox | ✅ Durable path |
| `worker-intel-director` | JetStream: `t.*.intel_brief.requested.v1` | Generates intelligence briefs (LLM + fallback) and writes the result to the outbox | ✅ Durable path |
| `worker-content-strategist` | JetStream: `t.*.intel_brief.v1` | Produces structured content briefs through the outbox | ✅ Durable path |
| `worker-blog-draft` | JetStream: `t.*.content_brief.v1` | Generates blog post drafts through the outbox | ✅ Durable path |
| `worker-critique` | JetStream: `t.*.blog_draft.v1` | Evaluates a draft against its playbook and writes `critique.completed.v1` to the outbox | ✅ Durable path |
| `worker-workflow-callback` | JetStream: tenant provisioning requests | Executes/verifies provisioning and writes lifecycle updates to the outbox | ✅ Complete |
| `worker-learning` | JetStream: `t.*.learning.signal.v1`, `t.*.critique.completed.v1`, `t.*.learning.proposal.approved.v1` | Persists feedback/critique proposals, applies evidence gates, and re-checks evidence after proposal approval | ✅ Evidence-governed durable path |
| `worker-warmth` | JetStream: `t.*.warmth.signal.v1` | Scores tenant-scoped engagement and emits an outreach gate | ✅ Durable deterministic path |
| `worker-attribution` | JetStream: `t.*.attribution.signal.v1` | Computes tenant-scoped multi-touch rollups | ✅ Durable deterministic path |

**Graceful degradation**: Workers that use LLM features (`intel-director`, `content-strategist`, `blog-draft`) automatically fall back to deterministic output when `OPENAI_API_KEY` is not set.

---

## 8. Packages

| Package | What it exports | Used by |
|---|---|---|
| `@growthos/db` | Drizzle schema, migrations, all repositories | api, all workers |
| `@growthos/core` | Motion scoring algorithm, handoff contracts, Restate client, tenant provisioning | api, workers |
| `@growthos/llm-harness` | OpenAI runner, prompt templates, ClickHouse LLM logger, signal grader | worker-intel-director, worker-blog-draft, worker-critique, worker-signal-router |
| `@growthos/adapter` | Paperclip HTTP client (companies, agents, issues, checkout/release/wakeup) | api |
| `@growthos/observability` | OTel SDK init, HTTP middleware, NATS middleware, structured logger | api, all workers |
| `@growthos/identity` | Zitadel client (stub in dev) | api |
| `@growthos/billing` | Lago billing client (stub in dev) | api |
| `@growthos/secrets` | Vault/OpenBao read/write wrappers | api, workers |
| `@growthos/skills` | Agent skill YAML frontmatter parser | api |
| `@growthos/design-system` | UI components (stub — no real components) | web |
| `@growthos/test-utils` | Vitest helpers, `testTenantId` constant | test files |
| `@growthos/paperclip-client` | (Empty — not implemented) | nowhere |

---

## 9. Database Schema

Schema: `packages/db/src/schema.ts`  
ORM: Drizzle  
Engine: PostgreSQL. Adaptive control-plane tables enforce tenant RLS; production
validation must also confirm tenant context and RLS coverage for every service
role and tenant-scoped table.

| Table | Purpose | Key columns |
|---|---|---|
| `motion_scores` | Scored GTM motions per tenant | `tenantId`, `motionType`, `score`, `scoredAt` |
| `motion_stack` | Current primary/secondary/observe/deactivated motions | `tenantId`, `primary`, `secondary`, `observe`, `deactivated` |
| `signal_events` | High-volume signal write path | `tenantId`, `externalId` (dedup key), `signalType`, `processedAt` |
| `approval_feedback` | Founder decisions for learning loop | `tenantId`, `issueId`, `outputType`, `action`, `learnOptIn` |
| `event_outbox` | Transactional outbox for event publishing | `tenantId`, `eventType`, `idempotencyKey`, `payload`, `consumedAt` |
| `workflow_runs` | Restate workflow state tracking | `tenantId`, `workflowId`, `state`, `failureCode` |
| `playbook_versions` | Versioned QA rubrics for critique worker | `tenantId`, `version`, `rubric`, `activeAt` |
| `tenant_settings` | Per-tenant UI preferences and config | `tenantId`, `settings` (JSONB) |
| `experiments` | Bounded, versioned GTM experiments | `tenantId`, `experimentKey`, `status`, `metricName`, `minSampleSize` |
| `experiment_assignments` | Sticky tenant/entity variant assignments | `tenantId`, `experimentId`, `entityType`, `entityId`, `variant` |
| `experiment_observations` | Idempotent outcome and attribution evidence | `tenantId`, `experimentId`, `assignmentId`, `metricName`, `attributionConfidence` |
| `learning_proposals` | Evidence-gated learning lifecycle | `tenantId`, `proposalKey`, `experimentId`, `status`, `evaluationSnapshot` |
| `component_health` | Bounded recovery decisions | `tenantId`, `componentId`, `state`, `action`, `allowExternalActions` |
| `incidents` | Sanitized operational incidents | `tenantId`, `incidentKey`, `severity`, `status`, `openedAt` |

**Migrations**: `packages/db/drizzle/`
**Seed**: `packages/db/src/seed.ts` — runs automatically in dev on first boot

---

## 10. Authentication & Authorization

### Web app

- Middleware: `apps/web/src/middleware.ts`
- Session cookie: `SESSION_COOKIE_NAME`
- All routes protected except `/login`, `/_next/*`, `/favicon.ico`
- Unauthenticated requests → redirect to `/login`
- Session tokens verified via `verifySessionToken()` in `apps/web/src/lib/auth-token.ts`

### API

- Middleware: `apps/api/src/auth-middleware.ts`
- Public routes: `GET /health`, `GET /v1/motion`, `GET /v1/approvals`
- Protected routes: Bearer token via `Authorization: Bearer <token>` + `X-Tenant-Id` header
- Token: `GROWTHOS_API_SERVICE_TOKEN` env var
- **Dev default**: when `GROWTHOS_API_SERVICE_TOKEN` is unset → permissive mode (all requests pass)

### Tenant isolation

- Tenant-scoped database tables use a `tenant_id` column
- Tenant-scoped API routes require an `X-Tenant-Id` header
- NATS subjects are scoped: `tenantScopedSubject(tenantId, eventType)`
- Adaptive control-plane tables have forced RLS policies; production must verify
  session tenant context and RLS coverage across the rest of the data model

---

## 11. Event Outbox Pattern

Business operations that emit an event write `event_outbox` atomically in the
same Postgres transaction as the business record. This guarantees that an
emitted event is not lost if the process crashes before publishing.

```
Business operation
    │
    ├── INSERT business record
    └── INSERT event_outbox { tenantId, eventType, idempotencyKey,
                              payload, consumedAt: null }
        (same transaction — atomically consistent)

worker-outbox-publisher (separate process):
    LOOP:
        SELECT * FROM event_outbox WHERE consumedAt IS NULL
        FOR EACH row:
            publish to NATS JetStream
            UPDATE event_outbox SET consumedAt = now()
```

A cycle-lease guard in `worker-outbox-publisher` prevents concurrent publishers (single-writer principle).

Workers consume events via **durable NATS subscriptions** — if a worker crashes mid-processing, the event is redelivered.

---

## 12. Environment Variables

### Required (have safe defaults in dev)

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | Set in compose.dev.yaml | Postgres connection string |
| `NATS_SERVERS` | `nats://nats:4222` | NATS JetStream connection |
| `PORT` | `3001` | API port |
| `GROWTHOS_SESSION_SECRET` | Dev default set | 32+ char session signing key |

### Optional — graceful degradation when missing

| Variable | Missing behaviour |
|---|---|
| `OPENAI_API_KEY` | LLM workers use deterministic fallback; `/v1/signals/grade` returns 503 |
| `PAPERCLIP_BASE_URL` + `PAPERCLIP_SERVICE_TOKEN` | Paperclip routes return empty/stub responses |
| `RESTATE_BASE_URL` + `RESTATE_API_KEY` | Workflow routes return 503 |
| `POSTAL_API_KEY` | Digest send returns `{ sent: false, reason: "postal_not_configured" }` |
| `ZITADEL_DOMAIN` + `ZITADEL_TOKEN` | Identity uses stub client |
| `LAGO_API_URL` + `LAGO_API_KEY` | Billing uses stub client |
| `GITEA_BASE_URL` + `GITEA_TOKEN` | Git workspace provisioning skipped |
| `CLICKHOUSE_URL` | LLM calls log to stdout only |
| `VAULT_ADDR` + `VAULT_TOKEN` | Secrets backend skipped |
| `GROWTHOS_API_SERVICE_TOKEN` | API runs in permissive mode (dev only) |

---

## 13. Docker & Infrastructure

### Dev stack (`compose.dev.yaml`)

| Service | Host port(s) → container port(s) | Purpose |
|---|---|---|
| `postgres` | 5442 → 5432 | Primary database |
| `nats` | 4222, 8222 | JetStream message broker |
| `jetstream-init` | — | One-shot: creates NATS streams |
| `clickhouse` | 8123 | LLM call logging |
| `minio` | 9000, 9001 | Object storage |
| `openbao` | 8200 | Secrets backend (Vault-compatible) |
| `gitea` | 3088 → 3000 | Git workspace (dev) |
| `migrate` | — | One-shot: runs DB migrations on first boot |
| `api` | 3091 → 3001 | Hono API |
| `web` | 3080 → 3000 | Next.js web app |

The infrastructure and API expose health checks where configured. `api`, `web`,
and workers wait on the migration/NATS dependencies declared in Compose; use the
operator runbook to confirm actual startup and health in an environment.

### Production

| Component | Location | Status |
|---|---|---|
| K8s manifests (Kustomize) | `deploy/gitops/k8s/base/` | Checked in; environment-specific hardening and deployment validation remain |
| ArgoCD Application | `deploy/gitops/argo-cd/application.yaml` | Checked in; cluster/repository configuration remains |
| Weekly digest CronJob | `deploy/gitops/k8s/base/cronjob-weekly-digest.yaml` | Checked in; requires production sender/secrets configuration |
| ExternalSecrets integration | K8s manifests | Manifests present; secret-store provisioning remains |
| Pulumi IaC | `deploy/pulumi/index.ts` | ❌ Stub only |

### Dockerfiles

Each app has its own Dockerfile under `docker/`:
- `docker/api.Dockerfile`
- `docker/web.Dockerfile`
- `docker/worker-*.Dockerfile`

---

## 14. Implementation Status

### Implemented code paths

These are implemented code paths, not a certification that external services,
production secrets, deployment infrastructure, or tenant-specific calibration
have been validated in a production environment.

- `apps/api` — all 9 route groups, auth middleware, Zod validation, error handling
- `apps/web` — all 9 pages, session auth, full UI flows
- `packages/db` — Drizzle schema, migrations, seed, base repositories, and durable adaptive control-plane repositories
- `packages/core` — motion scoring algorithm, handoff contracts, Restate client, tenant provisioning
- `packages/llm-harness` — OpenAI runner, ClickHouse logging, signal grader
- `packages/adapter` — Paperclip HTTP client (companies, agents, issues, checkout/release/wakeup)
- `packages/observability` — OTel SDK, HTTP + NATS middleware, structured logger
- `worker-signal-router` — leased `signal_events` inbox processing with idempotent outbox handoffs
- `worker-intel-director` — brief generation (LLM + deterministic fallback)
- `worker-content-strategist` — structured content brief from intel
- `worker-blog-draft` — blog draft generation
- `worker-critique` — durable JetStream quality gate against versioned playbooks
- `worker-learning` — durable feedback/critique/proposal consumers with persisted evidence gates and approval re-checks
- `worker-warmth` and `worker-attribution` — durable deterministic signal paths
- `worker-outbox-publisher` — outbox publisher, bounded dispatch lifecycle, and dead-letter incident materialization
- `worker-workflow-callback` — durable tenant-provisioning lifecycle consumer
- K8s + ArgoCD deployment manifests — checked-in artifacts, not a deployed-infrastructure certification

### Stubs — functional but minimal

| Area | Gap |
|---|---|
| `packages/llm-harness/src/prompt-template.ts` | Prompt templates are minimal system messages; functional but produce generic output. Need a real prompting pass. |
| Adaptive learning calibration | Durable proposal/promotion mechanics exist, but each tenant still needs calibrated outcome definitions, attribution thresholds, minimum samples, and guardrail tolerances. |
| `worker-warmth` | Deterministic scoring is durable, but needs learned/calibrated weights and cumulative-touch persistence for advanced use cases |
| `worker-attribution` | Durable multi-touch rollups exist, but cohort-level calibration and warehouse/ClickHouse reporting remain to be completed. |
| `packages/design-system` | No actual UI components; empty exports |
| `packages/test-utils` | Only exports `testTenantId` constant |
| `deploy/pulumi/index.ts` | `export const environment = pulumi.output("stub")` — no real infra |

### Not implemented

| Area | Notes |
|---|---|
| `packages/paperclip-client` | Directory exists but both files are empty; not imported anywhere |
| Restate workflow definitions | Config present, no actual workflow implementations |

---

## 15. Production Readiness Checklist

Before deploying to production:

- [ ] Set `OPENAI_API_KEY` — enables real LLM features across all workers
- [ ] Set `POSTAL_API_KEY` + configure sender domain — enables weekly digest emails
- [ ] Set `GROWTHOS_API_SERVICE_TOKEN` — disables permissive API mode
- [ ] Set `GROWTHOS_SESSION_SECRET` to a strong 32+ character random string
- [ ] Configure `RESTATE_BASE_URL` + `RESTATE_API_KEY` — enables workflow orchestration
- [ ] Configure `ZITADEL_DOMAIN` + `ZITADEL_TOKEN` — for real multi-tenant identity
- [ ] Configure `LAGO_API_URL` + `LAGO_API_KEY` — for billing metering
- [ ] Configure `VAULT_ADDR` + `VAULT_TOKEN` — for secrets backend
- [ ] Complete `deploy/pulumi/index.ts` — or provision cloud infrastructure manually
- [ ] Replace stub prompt templates in `packages/llm-harness/src/prompt-template.ts` with production prompts
- [ ] Validate the full Compose signal → experiment → outcome → approval → control-plane path with the [adaptive runtime runbook](runbooks/adaptive-gtm-local-runtime.md)
- [ ] Calibrate per-tenant learning policy: metric definitions, attribution confidence, minimum samples, lift, and guardrail tolerances
- [ ] Calibrate the attribution model and add ClickHouse rollups if sales attribution needs cohort-level reporting
- [ ] Verify forced Row-Level Security policies and session tenant context for every production service role and tenant-scoped table
- [ ] Set up monitoring dashboards (OTel collector, ClickHouse, NATS monitoring at `:8222`)
- [ ] Configure ArgoCD to point at your cluster + git repo

---

*For system architecture and design decisions, see [SYSTEM_DESIGN.md](./SYSTEM_DESIGN.md).*  
*For day-to-day operator tasks, see [USER_GUIDE.md](./USER_GUIDE.md).*  
*For runbooks, see [runbooks/](./runbooks/).*
