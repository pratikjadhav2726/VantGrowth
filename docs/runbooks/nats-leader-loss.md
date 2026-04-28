# Runbook: NATS JetStream Leader Loss

**Severity:** P1 — event plane halted; outbox publisher stalls; no new events delivered to workers.  
**Owner:** Platform on-call.  
**Last reviewed:** 2026-04-28

---

## Symptoms

| Signal | Where to look |
|---|---|
| `outbox.events.published.total` counter flat-lines | SigNoz / Grafana `outbox.publish_cycle` metric |
| `worker-outbox-publisher` logs `"nats: timeout"` or `"nats: connection closed"` | Structured log stream: `service = growthos.worker-outbox-publisher` |
| NATS monitor `/healthz` returns non-200 | `http://localhost:8228/healthz` (local) or NATS monitoring port |
| JetStream API returns `"no responders"` on `$JS.API.*` subjects | NATS client logs |
| NATS monitor `/jsz` shows `meta_leader = ""` | `curl http://<nats-host>:8228/jsz | jq .meta_leader` |

---

## Detection

```bash
# Check cluster health (replace localhost:8228 with monitoring port in prod)
curl -s http://localhost:8228/healthz | jq .

# Check JetStream meta-leader
curl -s http://localhost:8228/jsz | jq '{meta_leader: .meta_leader, cluster: .cluster}'

# Check stream state
curl -s http://localhost:8228/jsz?streams=1 | jq '.streams[] | {name: .config.name, state: .state}'

# Check server peers
curl -s http://localhost:8228/routez | jq '.routes | map({name: .name, did_solicit: .did_solicit, is_configured: .is_configured})'
```

---

## Immediate response

### Dev / local Compose (single-node)

```bash
# Inspect logs
docker compose -f compose.yaml logs nats --tail=50

# Restart the NATS container
docker compose -f compose.yaml restart nats

# Re-initialise streams (runs the jetstream-init job)
docker compose -f compose.yaml up -d jetstream-init

# Verify leader elected
curl -s http://localhost:8228/jsz | jq .meta_leader
```

### Production (3-node NATS cluster)

NATS Raft re-elects a new leader automatically within **2–5 seconds** of leader failure. Most of the time, no human action is needed.

```bash
# Step 1: Confirm the cluster is re-converging (watch for meta_leader to populate)
watch -n1 'curl -s http://<any-nats-host>:8228/jsz | jq .meta_leader'

# Step 2: If no leader after 30 seconds, check if a majority (2/3) of nodes are up
# A 3-node cluster requires 2 nodes for quorum.
curl -s http://<nats-host>:8228/routez | jq '.num_routes'
# Expected: 2 (each node sees 2 peers)

# Step 3: If only 1 node is alive, restart failed nodes
# (restart the container / pod / systemd unit on the failed hosts)
systemctl restart nats-server   # or: kubectl rollout restart deployment/nats -n growthos

# Step 4: Confirm consumer delivery resumes
# In a GrowthOS worker log, look for: "outbox publish cycle" span appearing
```

---

## Recovery verification

```bash
# Confirm meta_leader is elected
curl -s http://<nats-host>:8228/jsz | jq .meta_leader
# Expected: non-empty string, e.g. "nats-1"

# Confirm GROWTHOS stream exists with correct config
curl -s http://<nats-host>:8228/jsz?streams=1 | jq '.streams[] | select(.config.name=="GROWTHOS") | {name: .config.name, subjects: .config.subjects, num_msgs: .state.num_msgs}'

# Confirm outbox publisher has resumed (within 2x poll interval after NATS reconnects)
# Metric: outbox.events.published.total should be incrementing again
```

---

## Root-cause categories

| Category | Signs | Resolution |
|---|---|---|
| Single node crash | `num_routes = 1` on remaining nodes | Restart failed node |
| Network partition | Nodes up but `routez.num_routes < 2` | Restore network path between NATS hosts |
| OOM / resource exhaustion | Node OOM-killed | Scale memory; check `stream.state.bytes` against node RAM |
| Disk full on JetStream storage | `jetstream.stats.store` near limit | Expand storage or purge expired messages |
| Misconfigured `max_msgs_per_subject` | Stream stuck | Review `$JS.API.STREAM.INFO.GROWTHOS` |

---

## Outbox catch-up after recovery

The `worker-outbox-publisher` resumes its poll cycle automatically once the NATS connection is re-established (the `nats` client has built-in reconnect with backoff). No manual intervention needed.

If events were buffered in Postgres `event_outbox` while NATS was down, the poller drains them in batches (`OUTBOX_BATCH_SIZE_PER_TENANT` rows per tenant per cycle) until `consumed_at IS NULL` count reaches zero.

```bash
# Check unconsumed outbox depth
DATABASE_URL=postgresql://... psql -c \
  "SELECT tenant_id, count(*) FROM growthos.event_outbox WHERE consumed_at IS NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 10;"
```

---

## Post-incident checklist

- [ ] Root cause documented in incident tracker.
- [ ] Recovery time (leader-less window) measured and compared against SLO (<60 s).
- [ ] Check if stream `max_age` or `max_bytes` needs tuning.
- [ ] Confirm `jetstream-init` idempotency (stream create is `get-or-create`, not `recreate`).
- [ ] Review NATS server version; consider upgrading if a known Raft bug was involved.
