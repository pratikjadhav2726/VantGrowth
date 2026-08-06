# GrowthOS

[![CI](https://github.com/pratikjadhav2726/VantGrowth/actions/workflows/ci.yml/badge.svg?branch=dev)](https://github.com/pratikjadhav2726/VantGrowth/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

GrowthOS is a self-hostable, multi-tenant GTM operating system for teams that
want to turn customer, market, and product signals into governed marketing and
revenue work.

> **Project status: beta.** The core event-driven GTM loop is implemented and
> suitable for local development and supervised deployments. Review the
> [known limitations](#known-limitations) before using it for production or
> unattended external actions.

## Vision

GrowthOS is built around a simple idea: a small team should be able to operate
like a much larger GTM organization without giving software unchecked authority
over its brand, customer data, money, or reputation.

The long-term vision is an autonomous, evidence-governed GTM system that can:

- observe product, market, and customer signals;
- turn those signals into research, content, experiments, and recommended
  actions;
- apply tenant-specific policies, budgets, and approval gates before action;
- measure outcomes and learn from durable evidence; and
- retain a complete audit trail with safe rollback paths.

Autonomy is deliberately **governed**, not unconditional. External,
commercial, sensitive, or spend-increasing actions should remain behind the
tenant's explicit policy and approval rules until evidence and operational
controls justify greater automation.

## What works today

- A Next.js founder console for onboarding, motion scoring, approvals, weekly
  review, and settings.
- A Hono API for signals, motions, approvals, experiments, learning proposals,
  workflow callbacks, and tenant settings.
- Durable worker pipelines for signal routing, intelligence, content briefs,
  drafts, critique, learning, attribution, warmth, and outbox publishing.
- Multi-tenant data and event boundaries using Postgres, Row-Level Security,
  transactional outbox delivery, and NATS JetStream.
- An adaptive learning loop with evidence-gated promotion, human approval, and
  rollback references.
- n8n contracts for signed inbound signals and approved outbound SaaS actions.

## Architecture

```text
Signals from product, market, and SaaS tools
                 |
                 v
        GrowthOS API + tenant inbox
                 |
                 v
    leased routing -> transactional outbox
                 |
                 v
             NATS JetStream
                 |
                 v
 intel -> content -> draft -> critique -> learning
                 |
                 v
 policy + approval + n8n dispatch -> external outcome
                 |
                 v
      evidence, experiments, and rollback-aware learning
```

GrowthOS owns reasoning, policy, audit, and lifecycle state. n8n is the
connector fabric for downstream SaaS credentials, vendor-specific workflows,
and execution retries. See the [n8n end-to-end guide](docs/n8n/END_TO_END.md)
for the integration contract.

## Quick start

### Recommended: Docker development stack

Prerequisites: Docker Desktop and Docker Compose.

```bash
cp .env.example .env
docker compose -f compose.dev.yaml up --build -d
docker compose -f compose.dev.yaml ps
```

Open:

- Web: `http://localhost:3080`
- API health: `http://localhost:3091/health`

For a disposable local n8n instance, start the optional profile:

```bash
docker compose -f compose.dev.yaml --profile local-n8n up --build -d
```

The local demo accepts any valid email. Its default password is
`growthos-dev-admin`; override it with `GROWTHOS_WEB_ADMIN_PASSWORD`.

### Run from source

Prerequisites: Node.js 22+, pnpm 10+, and the local dependencies required by
the services you run.

```bash
pnpm install
pnpm dev
```

For database migrations, seed data, and the full local infrastructure stack,
follow [Local operations](#local-operations).

## Core API surface

| Area | Endpoints |
| --- | --- |
| Health and status | `GET /health`, `GET /v1/system/status` |
| Motions | `GET /v1/motion`, `POST /v1/motions/score` |
| Signals | `POST /v1/signals`, `POST /v1/signals/grade` |
| Approvals | `GET /v1/approvals`, `POST /v1/approvals/decide` |
| Learning | `GET /v1/learning-proposals`, experiment and outcome routes |
| n8n | `POST /v1/n8n/signals`, `POST /v1/n8n/dispatch` |
| Settings | `GET /v1/settings`, `PATCH /v1/settings` |

Protect mutation and control-plane routes in shared or production
environments with `GROWTHOS_API_SERVICE_TOKEN`. See [the user guide](docs/USER_GUIDE.md)
for the first-run flow and [the n8n guide](docs/n8n/END_TO_END.md) for signed
integration payloads.

## Integrations

### n8n

n8n is the active external connector layer. It sends normalized, signed signals
to GrowthOS and receives approved dispatch requests asynchronously. Configure
at least:

```bash
N8N_SHARED_SECRET=<replace-in-production>
N8N_DISPATCH_WEBHOOK_URL=<n8n-dispatch-webhook>
OUTBOX_TENANT_IDS=<comma-separated-tenant-uuids>
```

Use a different credential set for every tenant. Do not let a workflow bypass
GrowthOS policy, approval, idempotency, or tenant scoping.

### Paperclip

Paperclip is an optional control-plane integration for agent registration,
hiring governance, and issue tracking. It is not required for the native GTM
pipeline and is not a turnkey unattended-agent feature. Enable it only when a
Paperclip deployment, explicit tenant mapping, and the corresponding worker
configuration are in place. See [the Paperclip guide](paperclip_guide.md).

## Local operations

Start the complete local infrastructure stack (Postgres, NATS, Valkey, MinIO,
ClickHouse, Qdrant, Gitea, Meilisearch, and OpenBao):

```bash
pnpm infra:up
pnpm infra:ps
pnpm infra:down
```

Migration and development seed flow:

```bash
pnpm migrate:dry-run
pnpm migrate:apply
pnpm seed:dev
pnpm smoke:infra
```

Troubleshooting and operational runbooks live in the
[user guide](docs/USER_GUIDE.md) and [`docs/runbooks`](docs/runbooks).

## Development and quality

Before opening a pull request, run:

```bash
pnpm check
pnpm typecheck
pnpm test
```

For schema changes, also run:

```bash
pnpm migrate:dry-run
pnpm atlas:validate
pnpm atlas:lint
```

The CI workflow runs linting, type checks, unit tests, migration validation,
and RLS invariants on pull requests to the active development branches.

## Known limitations

- GrowthOS is beta software. Run it in a controlled environment and validate
  tenant policies, credentials, and operational monitoring before production.
- The supplied Docker configuration is for local development and demos; it is
  not a production deployment guide.
- Paperclip integration is optional and requires separate deployment and
  worker configuration. It should not be treated as a complete generic-agent
  executor.
- n8n workflows are intentionally tenant- and credential-specific. You must
  configure, secure, and test the workflows for each connected SaaS system.
- Do not enable unattended public, commercial, sensitive, or spend-increasing
  actions without explicit policies, approval gates, auditability, and
  incident response in place.

## Documentation

- [User guide](docs/USER_GUIDE.md)
- [n8n end-to-end integration](docs/n8n/END_TO_END.md)
- [Adaptive GTM harness](docs/ADAPTIVE_GTM_HARNESS.md)
- [Harness card](docs/GROWTHOS_HARNESS_CARD.md)
- [Technical architecture](Growthos_v4_Technical_Architecture.md)
- [Stack decisions](Growthos_v4_Stack_Decisions.md)
- [Implementation plan](Growthos_v4_Implementation_Plan.md)
- [Container images](docker/README.md)

## Contributing, security, and community

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the
development and pull-request workflow and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
for community expectations.

Please do **not** report vulnerabilities in public issues. Follow
[SECURITY.md](SECURITY.md) for responsible disclosure guidance.

## License

GrowthOS is released under the [MIT License](LICENSE).
