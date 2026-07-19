# @growthos/worker-paperclip-heartbeat

The GrowthOS-side **executor** for `growthos_native` agents.

Paperclip is the control plane: it registers agents, governs hiring (board
approval), tracks budgets, and holds the task/issue backlog — but it
**delegates execution of `growthos_native` agents back to GrowthOS**. (Invoking
such an agent directly in Paperclip fails with
`growthos_native execution must be handled by the GrowthOS worker`.)

This worker closes that loop:

```
GrowthOS provisions ──▶ Paperclip governs/approves ──▶ THIS worker executes
        (bootstrap-tenant)        (hire approval)          (poll → checkout → dispatch)
```

## What it does

On an interval (`PAPERCLIP_HEARTBEAT_POLL_MS`), for each configured company:

1. **Poll** Paperclip for issues (`GET /api/companies/:id/issues`).
2. **Filter** to *runnable* work — status in `PAPERCLIP_HEARTBEAT_RUNNABLE_STATUSES`
   (default `todo,backlog`) **and** assigned to an agent.
3. **Check out** the issue (`POST /api/issues/:id/checkout`) — claims it, locks
   it to a `runId`, moves it to `in_progress`.
4. **Persist** a `paperclip.work.ready.v1` event in the owning tenant's
   GrowthOS outbox.
5. The existing outbox publisher forwards it to JetStream as
   `t.<tenant-id>.paperclip.work.ready.v1`, then marks the outbox row consumed.

The handoff is durable: Paperclip is never coupled directly to NATS. If NATS is
unavailable, the checked-out issue has a committed outbox row and the publisher
retries delivery later. If the outbox write fails after checkout, the heartbeat
worker best-effort requeues only the issue it successfully claimed, preserving
its assignee for the next poll.

The work-ready payload includes the GrowthOS tenant ID plus Paperclip company,
agent, issue, and run IDs. Its idempotency key is
`<paperclip-run-id>:work-ready`; retries for one run reuse the same durable
outbox row. A domain worker consuming the event is responsible for execution and
for updating the Paperclip issue lifecycle.

## Config (env)

| Var | Default | Meaning |
|---|---|---|
| `PAPERCLIP_BASE_URL` | — | Paperclip API base (e.g. `http://paperclip:3100`) |
| `PAPERCLIP_SERVICE_TOKEN` | — | Board API key (instance-admin) |
| `PAPERCLIP_HEARTBEAT_COMPANY_IDS` | `[]` | Comma-separated company IDs to service |
| `PAPERCLIP_HEARTBEAT_COMPANY_TENANT_MAP` | `{}` | JSON object mapping each Paperclip company ID to its GrowthOS tenant UUID; required when live |
| `PAPERCLIP_HEARTBEAT_POLL_MS` | `15000` | Poll interval |
| `PAPERCLIP_HEARTBEAT_RUNNABLE_STATUSES` | `todo,backlog` | Statuses treated as runnable |
| `PAPERCLIP_HEARTBEAT_DRY_RUN` | `true` | When true, only logs candidates — no checkout/dispatch |
| `DATABASE_URL` | — | GrowthOS Postgres; required for live durable dispatch |
| `OUTBOX_TENANT_IDS` | — | Configured on `worker-outbox-publisher`; must include mapped tenant IDs so events reach JetStream |
| `WORKER_BOOTSTRAP` | — | Must be `true` for the process to start the loop |

## Run

```bash
# Docker (joins the growthos-dev network, dry-run by default)
docker compose -f compose.worker.yaml up -d --build
docker compose -f compose.worker.yaml logs -f worker-paperclip-heartbeat

# Configure a real ownership mapping, ensure OUTBOX_TENANT_IDS includes the
# mapped tenant, then flip to live execution.
PAPERCLIP_HEARTBEAT_COMPANY_IDS=<paperclip-company-id> \
PAPERCLIP_HEARTBEAT_COMPANY_TENANT_MAP='{"<paperclip-company-id>":"<growthos-tenant-uuid>"}' \
PAPERCLIP_HEARTBEAT_DRY_RUN=false \
docker compose -f compose.worker.yaml up -d

# Locally
WORKER_BOOTSTRAP=true pnpm --filter @growthos/worker-paperclip-heartbeat start
```

> A runnable issue needs an **assignee**. Freshly bootstrapped seed issues are
> unassigned (the agent starts `pending_approval`); after the hire is approved,
> assign the issue to the agent in Paperclip and the worker will pick it up.
