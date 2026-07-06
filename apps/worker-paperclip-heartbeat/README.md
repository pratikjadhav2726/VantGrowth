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
4. **Dispatch** it into the GrowthOS execution path.

### The dispatch seam (TODO)

`Dispatcher` in [`paperclip-heartbeat-worker.ts`](src/paperclip-heartbeat-worker.ts)
is where domain wiring goes. The default implementation only logs. Replace it to
map the issue to a motion / domain worker — e.g. publish a NATS event on
`t.<tenant>.paperclip.work.ready`, or enqueue via the outbox — and report
completion back to Paperclip (`releaseIssue` / status update / `wakeupAgent`).

## Config (env)

| Var | Default | Meaning |
|---|---|---|
| `PAPERCLIP_BASE_URL` | — | Paperclip API base (e.g. `http://paperclip:3100`) |
| `PAPERCLIP_SERVICE_TOKEN` | — | Board API key (instance-admin) |
| `PAPERCLIP_HEARTBEAT_COMPANY_IDS` | `[]` | Comma-separated company IDs to service |
| `PAPERCLIP_HEARTBEAT_POLL_MS` | `15000` | Poll interval |
| `PAPERCLIP_HEARTBEAT_RUNNABLE_STATUSES` | `todo,backlog` | Statuses treated as runnable |
| `PAPERCLIP_HEARTBEAT_DRY_RUN` | `true` | When true, only logs candidates — no checkout/dispatch |
| `WORKER_BOOTSTRAP` | — | Must be `true` for the process to start the loop |

## Run

```bash
# Docker (joins the growthos-dev network, dry-run by default)
docker compose -f compose.worker.yaml up -d --build
docker compose -f compose.worker.yaml logs -f worker-paperclip-heartbeat

# Flip to live execution
PAPERCLIP_HEARTBEAT_DRY_RUN=false docker compose -f compose.worker.yaml up -d

# Locally
WORKER_BOOTSTRAP=true pnpm --filter @growthos/worker-paperclip-heartbeat start
```

> A runnable issue needs an **assignee**. Freshly bootstrapped seed issues are
> unassigned (the agent starts `pending_approval`); after the hire is approved,
> assign the issue to the agent in Paperclip and the worker will pick it up.
