# GrowthOS

GrowthOS is a self-hostable GTM operating system that combines:

- a Next.js founder console (`apps/web`)
- a Hono API (`apps/api`)
- background workers for scoring, routing, critique, learning, and workflow callbacks
- tenant-scoped data/event infrastructure (Postgres + NATS + object storage + analytics)

It is designed for multi-tenant, asynchronous GTM operations where ingestion, scoring, approvals, and learning are all auditable and replayable.

## What this repo does

At a high level, this monorepo provides:

- **Founder UX** for onboarding, motion stack scoring, approval queue, weekly review, and settings
- **API contracts** for motions, approvals, signals, workflows, digest delivery, and tenant settings
- **Worker pipelines** for signal routing, critique, learning, outbox publishing, and provisioning callbacks
- **Data layer** with Drizzle + RLS patterns, migration workflows, and repository boundaries
- **Observability** via OpenTelemetry + structured logs

## Quick start

### Option A: local dev (pnpm)

```bash
pnpm install
pnpm dev
```

- Web: `http://localhost:3088`
- API: `http://localhost:3001`

### Option B: Docker dev stack (recommended for demos)

```bash
cp .env.example .env
docker compose -f compose.dev.yaml up --build -d
docker compose -f compose.dev.yaml ps
```

- Web: `http://localhost:3000`
- API: `http://localhost:3001`

Default login for local demo:

- Email: any valid email
- Password: `growthos-dev-admin` (or `GROWTHOS_WEB_ADMIN_PASSWORD` if set)

## Core endpoints

- `GET /health`
- `GET /v1/motion`
- `POST /v1/motions/score`
- `GET /v1/approvals`
- `POST /v1/approvals/decide`
- `POST /v1/signals`
- `POST /v1/signals/grade`
- `GET /v1/digest/weekly`
- `POST /v1/digest/send`
- `GET /v1/settings`
- `PATCH /v1/settings`

## Paperclip fork integration status

You are right to call this out: Paperclip is integrated, but currently optional and env-gated.

### Where it is used today

- API route `POST /v1/paperclip/bootstrap-tenant` creates:
  - Paperclip company
  - initial `growthos_native` agent
  - seed issue
- `TenantProvisioningOrchestrator` includes a `paperclip_company` step in the provisioning sequence
- `@growthos/adapter` contains typed Paperclip client contracts and `growthos_native` adapter schema

### Why it may look unused

- If `PAPERCLIP_BASE_URL` and `PAPERCLIP_SERVICE_TOKEN` are **not** set, the Paperclip client is disabled by design.
- In that mode, most local flows still work via GTM-native services, so Paperclip is not in the critical path.

### To enable your fork

Point GrowthOS at your Paperclip fork deployment by setting:

- `PAPERCLIP_BASE_URL`
- `PAPERCLIP_SERVICE_TOKEN`
- optional: `PAPERCLIP_TIMEOUT_MS`
- optional strict mode: `GROWTHOS_REQUIRE_PAPERCLIP=true` (API health turns unhealthy and web shows warning banner when disconnected)

See `.env.example` and `paperclip_guide.md`.

## n8n integration status

n8n is the active single connector fabric for external SaaS integrations. GrowthOS does not add direct HubSpot/Salesforce/Mixmax/Nooks/LinkedIn/etc. connectors; n8n normalizes those workflows and calls GrowthOS.

- Inbound: `POST /v1/n8n/signals` accepts signed n8n events and stores them as `signal_events`.
- Outbound: `POST /v1/n8n/dispatch` enqueues approved `n8n.dispatch.requested.v1` actions for async n8n execution.
- SmarterMCP is retained only as a disabled legacy reference, not an active dependency.

Configure:

- `N8N_SHARED_SECRET`
- `N8N_DISPATCH_WEBHOOK_URL`
- optional: `N8N_BASE_URL`, `N8N_API_KEY`, `N8N_TIMEOUT_MS`

## Local infra and operations

For full infra stack (Postgres, NATS, Valkey, MinIO, ClickHouse, Qdrant, Gitea, Meilisearch, OpenBao), use:

```bash
pnpm infra:up
pnpm infra:ps
pnpm infra:down
```

Migration and seed flow:

```bash
pnpm migrate:dry-run
pnpm migrate:apply
pnpm seed:dev
pnpm smoke:infra
```

## CI and quality gates

CI runs on PR/push:

- `pnpm check`
- `pnpm typecheck`
- `pnpm test`
- migration dry-run + Atlas validate/lint

## Docs

- Architecture: `Growthos_v4_Technical_Architecture.md`
- Stack decisions: `Growthos_v4_Stack_Decisions.md`
- Implementation status: `Growthos_v4_Implementation_Plan.md`
- Paperclip integration notes: `paperclip_guide.md`
- Container images: `docker/README.md`
- User guide: `docs/USER_GUIDE.md`
- Contributing: `CONTRIBUTING.md`
- Security policy: `SECURITY.md`
- Code of conduct: `CODE_OF_CONDUCT.md`
- Open-source checklist: `docs/OPEN_SOURCE_CHECKLIST.md`
