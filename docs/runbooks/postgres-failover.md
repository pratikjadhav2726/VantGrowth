# Runbook: Postgres Primary Failover

**Severity:** P0 — all write paths halted; `apps/api`, all workers, and migration tooling non-functional.  
**Owner:** Platform on-call.  
**Last reviewed:** 2026-04-28

---

## Symptoms

| Signal | Where to look |
|---|---|
| API returns `503 Service Unavailable` on all mutation endpoints | `apps/api` OTel span `growthos.api` with `http.response.status_code = 503` |
| Workers log `"connect ECONNREFUSED"` or `"Connection terminated unexpectedly"` | Structured logs: `err.code = "ECONNREFUSED"` or `"57P01"` |
| `outbox.events.published.total` counter flat-lines | Outbox publisher relies on Postgres for `listUnconsumed` |
| `pg_is_in_recovery()` returns `true` on what was the primary | `psql -c "SELECT pg_is_in_recovery();"` on each host |
| Patroni / repmgr leader key shows a new primary | `patronictl list` or `repmgr node status` |

---

## Architecture context

GrowthOS Postgres topology (production):

```
       ┌──────────────┐        ┌──────────────┐
  R/W  │   primary    │  WAL   │  replica-1   │  R/O (analytics, smoke)
──────►│  (primary)   │───────►│              │
       └──────────────┘        └──────────────┘
                                       │
                               ┌──────────────┐
                               │  replica-2   │  R/O (standby promote target)
                               │              │
                               └──────────────┘
```

High-availability is managed by **Patroni** (preferred) or **repmgr**. Failover is automatic when Patroni detects the primary is unreachable; the standby with the highest replay LSN is promoted.

Local/dev: single-node Postgres in Docker Compose — no failover; see Dev section below.

---

## Detection

```bash
# Identify current primary (any host)
psql "$DATABASE_URL" -c "SELECT inet_server_addr(), pg_is_in_recovery(), now();"

# Check Patroni cluster state (if using Patroni)
patronictl -c /etc/patroni/config.yml list

# Check replication lag on replicas
psql "$DATABASE_URL" -c "SELECT client_addr, state, sent_lsn - replay_lsn AS lag_bytes FROM pg_stat_replication;"

# Check RLS context is working on the current primary
psql "$DATABASE_URL" -c "SELECT set_config('app.tenant_id', 'test', true), current_setting('app.tenant_id', true);"
```

---

## Immediate response

### Dev / local Compose (single-node)

```bash
# Inspect logs
docker compose -f compose.yaml logs postgres --tail=50

# Restart
docker compose -f compose.yaml restart postgres

# Verify schema integrity
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5488/growthos_ci pnpm migrate:dry-run
```

### Production — automatic Patroni failover in progress

Patroni promotes a replica automatically. Typical duration: **10–30 seconds**.

```bash
# Step 1: Watch cluster state converge (run on any surviving host)
watch -n2 'patronictl -c /etc/patroni/config.yml list'
# Expected: one node transitions Leader, others become Replica

# Step 2: Confirm new leader is accepting writes
NEW_PRIMARY=<new-primary-host>
psql "postgresql://postgres:$PGPASSWORD@$NEW_PRIMARY:5432/growthos" -c "SELECT 1;"

# Step 3: Update DATABASE_URL in application secrets / Kubernetes ConfigMap to point to new primary
# If using PgBouncer / HAProxy with automatic leader tracking, this may be automatic.
kubectl set env deployment/growthos-api DATABASE_URL="postgresql://...@$NEW_PRIMARY:5432/growthos" -n growthos
kubectl rollout restart deployment/growthos-api -n growthos
# Repeat for each worker deployment
```

### Production — manual failover needed (Patroni unavailable)

```bash
# Step 1: Promote the most up-to-date replica
# Find replica with smallest replication lag:
# On each replica: psql -c "SELECT pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn();"
# Choose the replica with the highest value.

# Step 2: On the chosen replica
pg_ctl promote -D $PGDATA
# OR using repmgr:
repmgr standby promote -f /etc/repmgr.conf

# Step 3: Update other replicas to follow the new primary
# On each other replica:
repmgr standby follow -f /etc/repmgr.conf --upstream-node-id=<new-primary-id>

# Step 4: Point the application to the new primary (see above)
```

---

## Recovery verification

```bash
# Confirm new primary is writable
psql "$DATABASE_URL" -c "INSERT INTO growthos.event_outbox (tenant_id, event_type, idempotency_key, payload) VALUES (gen_random_uuid(), 'growthos.failover_test.v1', 'failover-smoke-$(date +%s)', '{}') RETURNING id;"
# DELETE the test row immediately after.

# Confirm RLS is intact on new primary
DATABASE_URL="$DATABASE_URL" pnpm migrate:dry-run
# Should succeed — migration is idempotent (IF NOT EXISTS guards)

# Run full RLS invariant suite against new primary
DATABASE_URL="$DATABASE_URL" pnpm --filter @growthos/db test
# All 15 generated invariant cases must pass

# Confirm outbox publisher is draining
# Check metric: outbox.events.published.total incrementing
```

---

## Post-failover: repair the old primary

Once the old primary is recovered:

```bash
# Rejoin as a replica (do NOT restart as primary — split-brain risk)
# Patroni will handle this automatically if the node comes back up.
# Manually with repmgr:
repmgr node rejoin -f /etc/repmgr.conf --force-rewind
```

---

## RLS invariants after failover

Row-Level Security is stored in `pg_catalog` (system catalogue), which is replicated via WAL. RLS policies are **always present** on both primary and replicas. No special action needed for RLS after failover.

---

## Root-cause categories

| Category | Signs | Resolution |
|---|---|---|
| OOM kill / kernel panic | System logs | Scale memory; add swap if constrained |
| Disk full | `ENOSPC` in Postgres logs | Emergency: `pg_ctl stop`, extend volume, start |
| `max_connections` exhausted | `FATAL: remaining connection slots reserved` | Scale PgBouncer pool; reduce idle connections |
| WAL archive lag | `archive_status` stuck | Check `archive_command`; clear stuck WAL files |
| Long-running transactions blocking autovacuum | `pg_stat_activity` shows idle-in-transaction | Kill with `SELECT pg_terminate_backend(pid)` |

---

## Post-incident checklist

- [ ] Root cause documented.
- [ ] RTO (application downtime) measured and compared against SLO (<120 s).
- [ ] Confirm old primary joined as replica without data divergence.
- [ ] Review `max_connections`, `work_mem`, connection pool sizing.
- [ ] Verify Patroni DCS (etcd/consul) is healthy — split-brain protection depends on it.
- [ ] Check that `pnpm rls:ci` (the generated RLS suite) passed after recovery.
