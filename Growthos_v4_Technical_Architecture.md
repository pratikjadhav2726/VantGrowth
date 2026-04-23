# GrowthOS v4 — Technical Architecture
**Motion-First Startup Operating System for GTM, Revenue, and Growth Execution**
**Companion to:** `Growthos_v4.md` (strategic spec), `paperclip_guide.md` (forked control plane), `SmarterMCP_guide.md` (deployed tool gateway)
**Audience:** Staff agentic-AI / platform engineers, infra leads, product architects
**Status:** Implementation-ready technical blueprint

---

## 0. How to read this document

`Growthos_v4.md` is the *what and why*. This document is the *how*. Every design choice here is made under three constraints that are not negotiable:

1. **We are not building an orchestration kernel.** Paperclip (forked) is that kernel. We harden it; we do not replace it. Every hour spent re-implementing org charts, heartbeats, approvals, or audit trails is an hour not spent on the GTM domain that is the actual moat.
2. **We are not building an MCP runtime.** SmarterMCP (deployed as a separate multi-tenant service) is that runtime. All tool calls leaving an agent go through it. No agent talks to an external SaaS directly.
3. **The domain layer is where the product lives.** Motion scoring, signal routing, learning, confidence, warmth, GEO, experiments, and attribution are *ours* to build and own. They are also what compounds.

If an architectural decision violates any of these three rules, it is wrong — even if it looks clean on a whiteboard.

---

## 1. System Topology

### 1.1 Process-level view

```text
                          ┌──────────────────────────────────────────┐
                          │            Founder Surfaces              │
                          │   Next.js web app · emails · webhooks    │
                          │   (Paperclip UI, extended)               │
                          └─────────────────┬────────────────────────┘
                                            │ HTTPS + Clerk session
                                            │
┌───────────────────────────────────────────▼─────────────────────────────────────────┐
│ GrowthOS API Gateway (Fastify/Next API)                                             │
│ · AuthN (Clerk)     · tenant resolve    · rate limit    · Stripe entitlement check  │
└───┬────────────────────────┬────────────────────────────────────────────┬───────────┘
    │                        │                                            │
┌───▼──────────────┐   ┌─────▼──────────────────┐               ┌─────────▼──────────┐
│ Paperclip Core   │   │ GrowthOS Domain Plane  │               │ Founder Digest /   │
│ (forked)         │◀─▶│ (new services)         │◀──events──────┤  Notifications     │
│                  │   │                        │               │  (Resend, webhooks)│
│ · agents         │   │ · Motion Engine        │               └────────────────────┘
│ · issues         │   │ · Signal Router        │
│ · routines       │   │ · Confidence Scorer    │
│ · approvals      │   │ · Experiment Manager   │
│ · heartbeat_runs │   │ · Learning Director    │
│ · exec policy    │   │ · Warmth Builder       │
│ · org/audit log  │   │ · GEO Monitor          │
└───┬──────────────┘   │ · Attribution          │
    │                  │ · Lifecycle Engine     │
    │                  │ · Skills Resolver      │
    │                  │ · Memory Resolver      │
    │                  └─────────┬──────────────┘
    │                            │
    │    ┌───────────────────────┴───────────────────────┐
    │    │                                               │
┌───▼────▼────────────┐                         ┌────────▼───────────────┐
│ BullMQ + Redis      │                         │ SmarterMCP Gateway     │
│ · heartbeat queue   │                         │ (separate service)     │
│ · signal router q.  │                         │ · tenant isolation     │
│ · critique q.       │                         │ · tool entitlements    │
│ · learning q.       │                         │ · DLP / filters        │
│ · attribution q.    │                         │ · proxy_search/filter  │
│ · delayed tasks     │                         │ · response cache       │
│ · dead-letter q.    │                         │ · per-tenant quotas    │
└───┬─────────────────┘                         └─────────┬──────────────┘
    │                                                     │
    │  (worker pools consume from queues)                 │ MCP/HTTPS
    │                                                     │
┌───▼──────────────────────────────────────────┐    ┌─────▼──────────────────────────┐
│ Postgres (Supabase or RDS)                   │    │ Upstream MCP servers / SaaS    │
│ · Paperclip schema (RLS enabled — v3 work)   │    │ CRM (HubSpot/Salesforce)       │
│ · GrowthOS domain schema (RLS enabled)       │    │ GA4 / Mixpanel / Segment       │
│ · partitioned activity_log, cost_events      │    │ LinkedIn / X / Slack / Reddit  │
│ · pgvector for memory + claims + evidence    │    │ Google/Perplexity/ChatGPT APIs │
└──────────────────────────────────────────────┘    │ Customer.io / Loops / Resend    │
                                                    │ Apollo / Clearbit / Exa.ai      │
                                                    │ Search APIs / GEO probes        │
                                                    └─────────────────────────────────┘
```

### 1.2 Process inventory (what actually runs)

| Process | Purpose | Language | Scaling unit |
|---|---|---|---|
| `api` | HTTP API + founder UI SSR | Node/TS | stateless, horizontal |
| `paperclip-core` (forked) | Agent registry, issues, approvals, audit | Node/TS | stateless, horizontal |
| `scheduler` | BullMQ producer replacing Paperclip's in-process timer (v3 item) | Node/TS | 1 leader (Redis lock), N followers |
| `worker-heartbeat` | Executes agent heartbeat runs | Node/TS | horizontal, one pool |
| `worker-signal-router` | Classifies, scores, and dispatches real-time signals | Node/TS | horizontal |
| `worker-critique` | Second-pass LLM self-critique + confidence scoring | Node/TS | horizontal, GPU-free |
| `worker-learning` | Learning Director synthesis pipeline | Node/TS | low concurrency, high memory |
| `worker-attribution` | Nightly/windowed multi-touch rollups | Node/TS | batch |
| `worker-warmth` | LinkedIn touch scheduling + content engagement tracker | Node/TS | horizontal |
| `worker-geo` | Periodic AI-search citation probes | Node/TS | horizontal, rate-limited |
| `outbox-relay` | Reads committed `event_outbox` rows and fans out via Redis Pub/Sub for live UI + WS clients (§3.6) | Node/TS | 1 leader (Redis lock), N followers |
| `ws-gateway` | Founder-facing WebSocket + SSE endpoint; subscribes to Redis Pub/Sub, maintains per-connection state (co-located with `api` in v1, split out at scale) | Node/TS | stateless, horizontal, any-instance-any-client |
| `smartermcp-gateway` | Tool gateway (SmarterMCP; treat as external service) | per vendor | separate deployment |
| `postgres` | System of record | Postgres 16 + pgvector | primary + read replicas |
| `redis` | Queues, locks, cache, signal stream | Redis 7 | Sentinel/Cluster |
| `object-store` | Attachments, exports, large evidence bundles | S3-compatible | managed |

**Design stance:** one DB, one Redis, many workers. We don't split microservices until a specific service earns it with a measurable scale or blast-radius problem. Shared schema with RLS is cheaper than a mesh of gRPC services for a 2026 startup.

---

## 2. Build vs Free — made exact

The v3 bullet list in the user brief is correct in spirit but fuzzy at the seams. Here is the precise contract.

### 2.1 From Paperclip (free, retained)

| Paperclip capability | GrowthOS reuse | Notes |
|---|---|---|
| `companies` | 1 per founder workspace (tenant) | `company.id` IS our `tenant_id` everywhere |
| `agents` table + adapter model | Each GrowthOS agent (Intel Director, Inbound Strategist, …) is a Paperclip agent | `adapterType = "growthos_native"` custom adapter |
| `issues` + `comments` + `documents` | Every unit of GTM work is an issue (content draft, outbound touch, experiment plan, weekly review, approval request) | Issue `identifier` becomes the stable external reference |
| `executionPolicy` stages | Our P0–P4 tiers map directly onto review/approval stages | See §9 |
| `approvals` (board) | Used for strategic changes: ICP edit, playbook major-version, motion stack change | Not every approval — only governance-level |
| `routines` | Non-real-time heartbeats (daily intel sweep, weekly review, lifecycle sweeps) | Cron-triggered routines become BullMQ jobs |
| `heartbeat_runs` | Full execution trace (events, logs, costs) | Treat as authoritative run-level audit |
| org chart + chain of command | Agent reporting structure; used for escalation and approval routing | |
| React dashboard UI | Base shell; we add motion/approval/experiment/review views | Forked, not rebased weekly — we track upstream (§3.5) |
| Budget tracking (`budgetMonthlyCents`) | Used for LLM + third-party cost envelopes per agent | Extended with cost_events table for granular attribution |

### 2.2 From SmarterMCP (free, deployed)

| SmarterMCP capability | GrowthOS reuse |
|---|---|
| Multi-tenant gateway | Each GrowthOS `company` = SmarterMCP `tenant` (1:1) |
| Tool entitlements | Motion stack → allowed tool set (inbound motion enables CMS tools, disables cold email tools) |
| `proxy_search`, `proxy_filter`, `proxy_explore` | All large-response tools (search, CRM list queries, analytics exports) go through proxies to save tokens |
| DLP / content filtering | Outbound content scanned for unverified claims, PII leakage, brand violations before dispatch |
| Response cache | Cached enrichment, search, competitor scrapes — reduces duplicate spend across agents |
| Audit trail | Immutable log of every tool call, joined against Paperclip `heartbeat_runs` by `X-Paperclip-Run-Id` |
| Rate limits & quotas | Per-tenant ceilings prevent a runaway agent from exhausting upstream credits |

### 2.3 What we build (new, v4)

These seven subsystems are the product. Everything else is plumbing.

1. **Motion Engine** — scorer, stack selector, agent resolver, skills resolver, template generator.
2. **Signal Router** — always-on real-time event pipeline (ingest → classify → urgency → dispatch).
3. **Structured Memory Store** — typed learnings, claims library, founder preferences, playbook versions, evidence.
4. **Confidence Scorer + Self-Critique** — second LLM pass + multi-factor scoring before any P2+ action.
5. **Experiment Framework** — variant generation, evaluation harness, promotion pipeline.
6. **Learning Director pipeline** — outcome ingestion → candidate learning → approval → skill update.
7. **Warmth Builder + GEO Monitor** — outbound warmth gradient enforcement; AI-answer-engine citation tracking.

Plus the hardening layer (§3) and the founder-facing product surfaces (§11).

---

## 3. Paperclip fork — the v3/v4 hardening deltas

We ship these as PRs into our fork. Each is a bounded change with a clear revert strategy. Upstream merges are tracked weekly (§3.5).

### 3.1 Distributed heartbeat scheduler (BullMQ + Redis)

**Problem:** Paperclip's in-process timer ticks inside the API server. Loses jobs on restart, doesn't survive horizontal scale, no retry semantics, no backpressure.

**Solution:** Replace the timer module with a BullMQ-backed scheduler. Public API surface (routines, wakeups, `/heartbeat/invoke`) stays identical; internal tick mechanism changes.

```text
┌────────────────────┐     cron / webhook / assignment     ┌──────────────────┐
│ Paperclip routines │──────────────────────────────────▶ │ BullMQ producer  │
│ & wakeup endpoints │                                     │ (in api process) │
└────────────────────┘                                     └────────┬─────────┘
                                                                    │ enqueue
                                                                    ▼
                                                     ┌──────────────────────────┐
                                                     │ Redis: heartbeat.queue   │
                                                     │   · delayed jobs         │
                                                     │   · priority by risk     │
                                                     │   · idempotency by key   │
                                                     │   · DLQ on 5 failures    │
                                                     └──────────┬───────────────┘
                                                                │
                                                ┌───────────────┼───────────────┐
                                                ▼               ▼               ▼
                                          worker pool A   worker pool B   worker pool C
                                          (heartbeat)     (signal)        (critique)
```

**Queues we run (all BullMQ, all per-tenant prefixed):**

| Queue | Concurrency | Rate limit | Retries | DLQ |
|---|---|---|---|---|
| `heartbeat` | 20 per worker | 10/s/tenant | 5, exp-backoff | yes |
| `signal-route` | 50 per worker | 100/s/tenant | 3 | yes |
| `critique` | 10 per worker | 20/s/tenant | 2 | yes |
| `learning` | 2 per worker | 1/s/tenant | 3 | yes |
| `attribution` | 4 per worker | 2/s/tenant | 3 | yes |
| `warmth` | 5 per worker | 5/s/tenant | 3 | yes |
| `geo` | 3 per worker | 1/s/tenant (upstream-limited) | 3 | yes |
| `dispatch` | 10 per worker | per-channel limits (see §10.3) | 3 | yes |
| `dlq-review` | — | — | — | manual |

**Idempotency key:** `${tenant_id}:${entity_type}:${entity_id}:${trigger}:${bucket}` where bucket is a rounded timestamp for time-based triggers. Prevents duplicate runs when a founder mashes "retry" or when a webhook is replayed.

**Leader election:** a tiny leader process acquires a Redis lock (`SET NX EX 10`, refreshed every 3s) to do one thing only — enqueue scheduled routines. Workers are stateless and multi-leader-safe.

### 3.2 Row-Level Security for all Paperclip tables

**Why we have to do this, now:** Paperclip was designed for a Paperclip-instance-per-company deployment model. GrowthOS is multi-tenant SaaS. Without RLS, one SQL injection or code bug exfiltrates every founder's CRM mirror and playbook.

**Strategy:** every Paperclip table gets a `tenant_id` column (backfilled from `company_id` where present), a policy, and a default role. We never run "superuser" queries from API code; we always run under a session role bound to the requesting tenant.

Template we apply to every Paperclip table:

```sql
ALTER TABLE paperclip.issues ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE paperclip.issues SET tenant_id = company_id WHERE tenant_id IS NULL;
ALTER TABLE paperclip.issues ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE paperclip.issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE paperclip.issues FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON paperclip.issues
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON paperclip.issues TO growthos_app;
```

Every API request begins with:

```sql
SET LOCAL app.tenant_id = '<resolved company uuid>';
SET LOCAL app.actor_id  = '<resolved agent or user uuid>';
SET LOCAL app.actor_kind = 'user' | 'agent' | 'system';
```

Workers do the same on every job start. We audit by tailing Postgres logs for any query lacking the `SET LOCAL app.tenant_id` preamble (enforced via a pgAudit rule in staging).

**Admin bypass:** a separate Postgres role `growthos_admin` (used only by Stripe webhooks, platform migrations, and one-off support tools) can bypass RLS via `BYPASSRLS`. It is gated by a separate connection pool and separate Clerk auth scope.

### 3.3 Redis cache layer for Paperclip entity reads

Paperclip's hot reads — `/agents/me`, `/org`, `/issues/:id`, inbox queries — hit Postgres on every heartbeat tick. With many agents per company, this becomes the bottleneck long before the DB is actually loaded.

**Cache keys (all tenant-prefixed):**

```
t:{tenant}:agent:{agent_id}            TTL 60s
t:{tenant}:agent:me:{api_key_hash}     TTL 60s
t:{tenant}:org                         TTL 300s, invalidated on agent create/update/terminate
t:{tenant}:issue:{issue_id}            TTL 30s, write-through on PATCH
t:{tenant}:inbox:{agent_id}            TTL 15s
```

**Invalidation:** every Paperclip write emits a Postgres `NOTIFY` on channel `cache.invalidate` with the key pattern. A small listener process translates NOTIFYs to Redis `DEL`s. Write-through on critical entities (issue updates) to avoid a TOCTOU window.

**Rule:** never cache anything that contains a confidence score, risk tier, or approval decision with a TTL > 5 seconds. Those must reflect the current truth.

### 3.4 Partitioned activity_log and cost_events

Both tables are append-only, time-series, and grow fast. They are also the things auditors and founders query by recent range.

```sql
CREATE TABLE activity_log (
  id            UUID NOT NULL,
  tenant_id     UUID NOT NULL,
  actor_id      UUID,
  actor_kind    TEXT NOT NULL,
  run_id        UUID,
  event_type    TEXT NOT NULL,
  entity_type   TEXT,
  entity_id     UUID,
  payload       JSONB,
  occurred_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, occurred_at, id)
) PARTITION BY RANGE (occurred_at);

-- pg_partman manages monthly partitions + 18-month retention (hot), older archived to S3/Parquet.
```

`cost_events` follows the same pattern, partitioned monthly. Columns: `tenant_id, agent_id, run_id, issue_id, category (llm|search|enrich|email|social|geo), provider, unit_count, unit_cost_micros, total_micros, occurred_at`.

**Roll-up strategy:** a materialized view `cost_daily_by_agent` refreshed every 5 minutes backs the founder's cost dashboard. Raw partitions are queried only for drill-downs.

### 3.5 Tracking upstream

Paperclip moves fast (the brief mentions 2+ releases/week). Divergence strategy:

1. Fork lives in GitHub org; `main` tracks our production. `upstream-sync` branch pulls upstream weekly via `git fetch upstream && git merge upstream/main`.
2. Every hardening delta ships as a PR with a `growthos/` prefix and is kept on its own branch for as long as possible before merging into `main`. This keeps `upstream-sync → main` merges tractable.
3. A weekly 30-minute triage: categorize each upstream commit as (a) accept, (b) accept with adapt, (c) reject (conflicts with our RLS/BullMQ model), (d) upstream our patch.
4. RLS is non-negotiable; anything upstream that introduces cross-tenant reads without a tenant scope is rejected or adapted.

### 3.6 Distributed live-events fan-out (Redis Pub/Sub)

**Problem:** Paperclip's `LiveEventsServer` holds per-company WebSocket subscriptions **in-process**. With N stateless API instances (required by §3.1's distributed scheduler), a WS client connected to instance A will not receive events published from instance B. The founder dashboard shows missing run updates, stale approval queue state, and ghosted heartbeats — a direct trust killer and a blocker for multi-user workspaces (§15 Phase 3).

**Solution:** Replace the in-process subscription map with a Redis Pub/Sub-backed fan-out that reuses the existing `event_outbox` (§5.3) as the single source of truth. No second broker, no second write path, no split-brain.

```text
   ┌─ api instance A ──┐               ┌─ api instance B ──┐
   │  WS clients: {c1} │               │  WS clients: {c2} │
   │  LiveEvents local │               │  LiveEvents local │
   │  pubsub subscriber├──┐         ┌──┤ pubsub subscriber │
   └───────────────────┘  │         │  └───────────────────┘
                          ▼         ▼
                  ┌──────────────────────┐
                  │ Redis Pub/Sub        │
                  │ channels:            │
                  │   t:{tenant}:run:*   │
                  │   t:{tenant}:issue:* │
                  │   t:{tenant}:approval│
                  │   t:{tenant}:signal  │
                  │   t:{tenant}:learn   │
                  └──────────▲───────────┘
                             │ PUBLISH
                             │
                  ┌──────────┴───────────┐
                  │ outbox-relay         │
                  │ · leader-elected     │
                  │ · LISTEN on NOTIFY   │
                  │ · reads event_outbox │
                  │ · publishes per event│
                  │ · updates consumed_at│
                  └──────────▲───────────┘
                             │ NOTIFY 'outbox.ready'
                             │
   ┌─────────────────────────┴─────────────────────────┐
   │ Producers (workers, api mutations, SmarterMCP hooks)│
   │  → every domain write also inserts event_outbox row │
   │    in the SAME transaction                          │
   └────────────────────────────────────────────────────┘
```

**Key design points:**

- **`event_outbox` remains the only write destination.** Producers write the outbox row in the same transaction as the domain mutation (§5.3). The relay is a read-side concern. Exactly-captured, at-least-once delivery semantics are unchanged.
- **Tenant-prefixed channels** (`t:{tenant}:...`). Each `api` instance subscribes only to channels for tenants with active local WS connections, not all channels. Fan-out cost per instance is bounded by connected-users, not by total tenant count.
- **Sticky sessions are optional, not required.** Because any instance can receive any event via Pub/Sub, we don't need a Layer-7 sticky LB. Rolling deploys stay painless.
- **Backfill on connect.** WS clients send `last_seen_event_id` on connect. The gateway replays missed events from `activity_log` for that tenant, then joins the live Pub/Sub stream. Zero-gap reconnects survive instance restarts and brief Redis blips.
- **Presence tracking via Redis, not memory.** The old in-memory "who is connected" map becomes `SADD t:{tenant}:live_clients:{client_id}` with 30s TTL refresh. The UI's "agent is running" indicator stays correct across instances.
- **Leader election for the relay** uses the same Redis lock pattern as the scheduler (§3.1). Followers stay warm; takeover is < 3s.
- **Scale ceiling upgrade path.** Redis Pub/Sub is fine to ~10k msg/s/cluster. When we outgrow it, swap the relay publish target to NATS JetStream or Redis Streams consumer groups. The WS gateway's `LiveEventsServer` abstraction hides the change from the UI.
- **Fallback to SSE.** For corporate networks that block WS, the same Redis Pub/Sub backbone serves SSE over HTTP/2. Single abstraction, two transports.

**Interface the UI sees (unchanged from Paperclip's `LiveEventsServer`):**

```typescript
interface LiveEventsClient {
  subscribe(channel: string, handler: (e: LiveEvent) => void): Unsubscribe;
  onReconnect(handler: (gapEvents: LiveEvent[]) => void): void;
  lastSeenEventId: bigint;
}
```

**Circuit breakers:**
- If Pub/Sub is down, WS gateway degrades to polling `activity_log` every 2s and shows a "live updates delayed" banner.
- If the outbox-relay leader is down and no follower takes over in 10s, a CloudWatch alarm pages oncall and the UI banner appears.
- Producers never fail on publish errors (outbox row is already durable); the relay will catch up when it recovers.

**Bounded-PR implementation in the Paperclip fork:**

1. Replace `LiveEventsServer`'s in-process subscription map with `RedisPubSubBackedSubscriptionRegistry`.
2. Remove the direct `liveEvents.emit(...)` call path — producers already write `event_outbox`; nothing else changes.
3. WS `/ws` endpoint accepts `last_seen_event_id` query param → backfill handler queries `activity_log` for gap.
4. New metrics: `ws_connected_clients{instance}`, `pubsub_fanout_latency_ms`, `backfill_events_replayed`, `outbox_relay_lag_ms`, `outbox_unconsumed_count{tenant}`.

This is the 8th hardening delta in the fork-track, peer with RLS and BullMQ. Must land **before** any multi-user workspace work (§15 Phase 3) because presence and live approval queue coordination break without it.

---

## 4. SmarterMCP integration architecture

SmarterMCP is not "just a proxy." We treat it as the **tool execution kernel** and build our agent contract around it.

### 4.1 Adapter: `growthos_native` on Paperclip

Paperclip's adapter model lets us plug in any runtime. We ship one adapter. Responsibilities:

```text
On heartbeat tick:
  1. Read run context from Paperclip (agent, issue, comments, documents, chain of command)
  2. Resolve skills (see §7.2) from our skills library + active experiments
  3. Resolve memory (see §7.3) from structured memory store
  4. Compose structured system + user prompt (never free-text pasted)
  5. Call LLM with a scoped SmarterMCP session:
       - session.tenant_id = company.id
       - session.entitlements = motion_stack → tool_allowlist
       - session.run_id = paperclip_run_id
       - session.budget_cap = min(agent.remaining_budget, run.cap)
  6. Model emits either:
       a. structured output (JSON schema enforced)
       b. tool call (routed via SmarterMCP)
  7. On structured output:
       - write to issue document (key = output_type)
       - enqueue self-critique
       - enqueue confidence scoring
  8. On tool call:
       - SmarterMCP validates entitlement + DLP
       - response returns (possibly truncated with proxy handle)
       - loop to step 5 until model emits final output
  9. Write run summary, cost_events, activity_log entries
```

**One agent = one LLM session = one Paperclip run = one SmarterMCP session**. This 1:1:1:1 mapping is how we join traces across systems.

### 4.2 Tool catalog and entitlement matrix

Tools are grouped into *tool packs*. Motion activation enables tool packs, not individual tools. This matches the mental model operators have.

| Tool pack | Tools | Enabled by motion |
|---|---|---|
| `research.web` | search, url-fetch, exa, perplexity | all motions |
| `research.social` | linkedin-view, x-view, reddit-view | inbound, community, outbound |
| `research.enrichment` | apollo, clearbit, crunchbase | outbound, abm, partners |
| `crm.read` | hubspot-read, salesforce-read | all |
| `crm.write` | hubspot-write, salesforce-write | outbound, lifecycle, abm |
| `content.cms` | webflow, sanity, ghost | inbound |
| `content.publish.social` | linkedin-post, x-post | community, inbound |
| `messaging.email` | customer-io, loops, resend | lifecycle, outbound |
| `messaging.in_app` | pendo, appcues | lifecycle, plg |
| `analytics.read` | ga4, mixpanel, segment | all |
| `geo.probe` | chatgpt-search, perplexity-answer, google-sge | inbound (with GEO sub-skill) |

**Enforcement:** SmarterMCP is told the tool allowlist at session start. An agent cannot call a tool outside its motion's allowlist even if the LLM hallucinates a tool name — SmarterMCP refuses, logs, and returns a structured error the model can reason about.

### 4.3 DLP policies per action tier

SmarterMCP DLP runs on both request and response payloads. We configure policies per tier:

| Tier | Request-side rules | Response-side rules |
|---|---|---|
| P0/P1 | block obvious PII leakage in prompts | redact customer PII from scraped content |
| P2 (public) | block if contains `unverified_claim` token injected by claims-library checker | block if contains competitor names on do-not-mention list |
| P3 (commercial/outbound) | require presence of `warmth_score_token` or `cold_override=true` | strip tracking pixels if tenant policy disallows |
| P4 (sensitive) | no LLM dispatch allowed — human drafts | n/a |

DLP blocks are not silent; they create an `activity_log` entry with `event_type = 'risk.blocked'` and surface in the founder's approval queue as "blocked — reason."

### 4.4 Response caching and proxy exploration

Every SmarterMCP response > 4KB is cached with a content hash. The agent receives a *handle* + preview summary + token estimate. When the agent wants to drill down, it calls `proxy_search` or `proxy_filter` — a second round-trip that is ~10–100× cheaper than re-fetching the full response.

This is how we keep an "Intel Director" that reads 50 competitor pages/day inside a $200/month LLM budget.

---

## 5. Data model

We run one Postgres database, two logical schemas: `paperclip.*` (forked, hardened) and `growthos.*` (domain). All tables have `tenant_id`, all have RLS, all have `created_at`.

### 5.1 Core domain tables (growthos schema)

```sql
-- Motion state
CREATE TABLE growthos.motion_scores (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  scored_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  scorer_version TEXT NOT NULL,
  scores         JSONB NOT NULL,          -- { inbound: 8.8, outbound: 6.7, ... }
  inputs_digest  TEXT NOT NULL,            -- hash of inputs that produced this score
  rationale      TEXT[] NOT NULL DEFAULT '{}'
);

CREATE TABLE growthos.motion_stack (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL UNIQUE,      -- one active stack per tenant
  primary_motions   TEXT[] NOT NULL,
  secondary_motions TEXT[] NOT NULL,
  observe_only      TEXT[] NOT NULL DEFAULT '{}',
  deactivated       TEXT[] NOT NULL DEFAULT '{}',
  source_score_id   UUID REFERENCES growthos.motion_scores(id),
  approved_by       UUID,                  -- user who approved
  approved_at       TIMESTAMPTZ,
  version           INT NOT NULL DEFAULT 1
);

-- Signals (real-time)
CREATE TABLE growthos.signal_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  source      TEXT NOT NULL,               -- webhook.hubspot, cron.geo, inbox.email ...
  kind        TEXT NOT NULL,               -- prospect.replied, competitor.pricing_change, ...
  raw_payload JSONB NOT NULL,
  dedupe_key  TEXT NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, dedupe_key)
) PARTITION BY RANGE (ingested_at);

CREATE TABLE growthos.signals (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  event_id       UUID NOT NULL REFERENCES growthos.signal_events(id),
  motion         TEXT,                      -- nullable if general
  urgency        TEXT NOT NULL CHECK (urgency IN ('p0','p1','p2','p3')),
  half_life_min  INT NOT NULL,              -- time after which this signal goes stale
  classifier_ver TEXT NOT NULL,
  target_agent   TEXT,                      -- resolved downstream agent
  dispatched_at  TIMESTAMPTZ,
  dispatched_run_id UUID,                   -- paperclip run
  outcome        TEXT
);

-- Structured memory (the spine of the learning system)
CREATE TABLE growthos.gtm_learnings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  scope           TEXT NOT NULL CHECK (scope IN ('founder','segment','global')),
  motion          TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  pattern_type    TEXT NOT NULL,
  description     TEXT NOT NULL,
  evidence_count  INT NOT NULL,
  confidence      NUMERIC(4,3) NOT NULL,
  impact_metric   TEXT NOT NULL,
  impact_delta    NUMERIC(8,4),
  ttl_days        INT NOT NULL DEFAULT 90,
  learned_from    TEXT[] NOT NULL DEFAULT '{}',  -- pointers to experiments, approvals
  status          TEXT NOT NULL CHECK (status IN ('candidate','active','expired','rejected','superseded')),
  approved_by     UUID,
  approved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_validated_at TIMESTAMPTZ,
  supersedes_id   UUID REFERENCES growthos.gtm_learnings(id),
  embedding       VECTOR(1536)              -- pgvector, for retrieval by Memory Resolver
);

CREATE TABLE growthos.approval_feedback (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  issue_id        UUID NOT NULL,            -- paperclip issue
  output_type     TEXT NOT NULL,            -- blog_draft, outbound_touch, reply_draft, ...
  action          TEXT NOT NULL CHECK (action IN ('approved','edited_then_approved','rejected','auto_approved')),
  edit_distance   NUMERIC(6,4),             -- normalized 0..1
  rubric_failures TEXT[] NOT NULL DEFAULT '{}',
  reviewer_note   TEXT,
  learn_opt_in    BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Claims library (what agents are allowed to say about the product)
CREATE TABLE growthos.content_claims (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  claim          TEXT NOT NULL,
  claim_type     TEXT NOT NULL,             -- performance, feature, customer_quote, integration, ...
  verification   TEXT NOT NULL CHECK (verification IN ('verified','pending','retired')),
  evidence_url   TEXT,
  valid_until    DATE,
  embedding      VECTOR(1536)
);

-- Experiments
CREATE TABLE growthos.experiments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL,
  motion           TEXT NOT NULL,
  experiment_type  TEXT NOT NULL,
  hypothesis       TEXT NOT NULL,
  unit_type        TEXT NOT NULL,            -- content_piece, outbound_sequence, lifecycle_step
  variant_a        JSONB NOT NULL,
  variant_b        JSONB NOT NULL,
  traffic_split    NUMERIC(4,3) NOT NULL DEFAULT 0.5,
  metric_name      TEXT NOT NULL,
  min_sample_size  INT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('proposed','running','concluded','abandoned','promoted')),
  winner           TEXT CHECK (winner IN ('a','b','inconclusive')),
  confidence       NUMERIC(4,3),
  started_at       TIMESTAMPTZ,
  ended_at         TIMESTAMPTZ,
  promoted_at      TIMESTAMPTZ,
  resulting_learning_id UUID REFERENCES growthos.gtm_learnings(id)
);

CREATE TABLE growthos.experiment_observations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  experiment_id  UUID NOT NULL REFERENCES growthos.experiments(id),
  variant        TEXT NOT NULL,
  unit_id        TEXT NOT NULL,              -- e.g. content piece slug or outbound touch id
  metric_value   NUMERIC,
  observed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Playbook versioning
CREATE TABLE growthos.playbook_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  motion          TEXT NOT NULL,
  artifact_type   TEXT NOT NULL CHECK (artifact_type IN ('skills','policy','workflow','messaging')),
  artifact_key    TEXT NOT NULL,              -- e.g. "skills/inbound/content_strategist.md"
  content         JSONB NOT NULL,             -- or TEXT for markdown
  version         INT NOT NULL,
  change_reason   TEXT NOT NULL,
  change_source   TEXT NOT NULL,              -- learning_id, manual, experiment_id
  approved_by     UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, motion, artifact_type, artifact_key, version)
);

-- Confidence scores per output
CREATE TABLE growthos.confidence_scores (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  issue_id        UUID NOT NULL,
  output_type     TEXT NOT NULL,
  factor_scores   JSONB NOT NULL,              -- { structural: 0.9, policy: 1.0, evidence: 0.7, ... }
  composite_score NUMERIC(4,3) NOT NULL,
  risk_tier       TEXT NOT NULL CHECK (risk_tier IN ('P0','P1','P2','P3','P4')),
  auto_eligible   BOOLEAN NOT NULL,
  scorer_version  TEXT NOT NULL,
  critic_run_id   UUID,                        -- pointer to critique run
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Warmth (outbound)
CREATE TABLE growthos.warmth_subjects (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  subject_type   TEXT NOT NULL CHECK (subject_type IN ('person','account')),
  external_id    TEXT NOT NULL,                -- linkedin_id, domain, crm_id
  current_score  NUMERIC(4,3) NOT NULL DEFAULT 0,
  last_touch_at  TIMESTAMPTZ,
  UNIQUE (tenant_id, subject_type, external_id)
);

CREATE TABLE growthos.warmth_touches (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  subject_id     UUID NOT NULL REFERENCES growthos.warmth_subjects(id),
  touch_type     TEXT NOT NULL,                -- linkedin_view, linkedin_like, linkedin_comment, content_read, reply, meeting
  source         TEXT NOT NULL,
  weight         NUMERIC(4,3) NOT NULL,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- GEO (AI-answer-engine citation tracking)
CREATE TABLE growthos.geo_prompts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  prompt         TEXT NOT NULL,
  intent         TEXT NOT NULL,                -- comparison, how_to, recommendation, definition
  priority       INT NOT NULL DEFAULT 0
);

CREATE TABLE growthos.geo_citations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  prompt_id      UUID NOT NULL REFERENCES growthos.geo_prompts(id),
  engine         TEXT NOT NULL,                -- chatgpt, perplexity, google_sge, claude
  probed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  cited          BOOLEAN NOT NULL,
  rank           INT,
  cited_url      TEXT,
  answer_snippet TEXT,
  competitor_cited TEXT[]
) PARTITION BY RANGE (probed_at);

-- Lifecycle
CREATE TABLE growthos.lifecycle_state (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  subject_type   TEXT NOT NULL CHECK (subject_type IN ('user','account')),
  external_id    TEXT NOT NULL,
  stage          TEXT NOT NULL,                -- aware, activated, converted, retained, expanded, at_risk, churned
  health_score   NUMERIC(4,3),
  stage_entered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  prev_stage     TEXT,
  UNIQUE (tenant_id, subject_type, external_id)
);

-- Attribution (event-level, rolled up into paths)
CREATE TABLE growthos.attribution_touchpoints (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  subject_type   TEXT NOT NULL,
  external_id    TEXT NOT NULL,
  touchpoint_type TEXT NOT NULL,                -- content_view, reply, community_touch, ad_click, ...
  source_agent_id TEXT,
  source_issue_id UUID,
  motion         TEXT,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now()
) PARTITION BY RANGE (occurred_at);

-- Skills (motion-indexed library, stored alongside playbook_versions as artifact_type='skills')
-- Runtime-loaded; canonical source lives in versioned git repo; DB stores the active version per tenant.

-- Memory items (non-learning structured memory: founder preferences, ICP snapshots, do-not-send lists)
CREATE TABLE growthos.memory_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  kind           TEXT NOT NULL,                -- icp_snapshot, founder_voice, do_not_mention, messaging_matrix, ...
  scope          TEXT NOT NULL,                -- global, motion, agent, segment
  scope_key      TEXT,
  content        JSONB NOT NULL,
  version        INT NOT NULL DEFAULT 1,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_to   TIMESTAMPTZ,
  embedding      VECTOR(1536),
  UNIQUE (tenant_id, kind, scope, scope_key, version)
);
```

### 5.2 Indexing strategy (the ones that matter)

```sql
-- Hot-path reads
CREATE INDEX ON growthos.signals (tenant_id, urgency, dispatched_at NULLS FIRST);
CREATE INDEX ON growthos.gtm_learnings (tenant_id, status, motion) WHERE status = 'active';
CREATE INDEX ON growthos.gtm_learnings USING ivfflat (embedding vector_cosine_ops);
CREATE INDEX ON growthos.confidence_scores (tenant_id, issue_id);
CREATE INDEX ON growthos.approval_feedback (tenant_id, output_type, created_at DESC);
CREATE INDEX ON growthos.warmth_subjects (tenant_id, current_score DESC);
CREATE INDEX ON growthos.memory_items USING ivfflat (embedding vector_cosine_ops);

-- Partitioned tables get per-partition indexes via pg_partman templates
```

### 5.3 Event emission

All domain-state changes emit to an event bus table that workers subscribe to via Postgres logical replication (or, cheaper v1: polling with a `consumed_at` marker and `ON CONFLICT DO NOTHING`). Taxonomy per `Growthos_v4.md` §9.3. Event is also written to `activity_log` for audit.

```sql
CREATE TABLE growthos.event_outbox (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  UUID NOT NULL,
  event_type TEXT NOT NULL,                  -- motion.stack.selected, learning.activated, ...
  payload    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at TIMESTAMPTZ
);
CREATE INDEX ON growthos.event_outbox (tenant_id, consumed_at NULLS FIRST, id);
```

**Write pattern:** every domain mutation and its outbox insert happen in one transaction. Guarantees at-least-once delivery without a separate broker. When v2 scale demands it, swap the poller for logical replication → Kafka.

**Read fan-out:** the `outbox-relay` process (§3.6) reads committed outbox rows, publishes them to Redis Pub/Sub for live UI consumption, and updates `consumed_at`. The same relay is the single feeder for (a) WebSocket/SSE to the founder dashboard, (b) internal worker event subscriptions that do not want to poll, and (c) future external webhook delivery. Workers that need guaranteed delivery still consume directly from the outbox table with their own `consumed_at` marker — Pub/Sub is best-effort for live UI; the outbox is the contract.

---

## 6. Domain services

Each service in this section is a **module**, not necessarily a process. Some run as dedicated workers (Signal Router, Learning Director, GEO Monitor); others are libraries called from the adapter (Motion Engine, Confidence Scorer, Skills Resolver). Process/module mapping is in §1.2.

### 6.1 Motion Engine

**Responsibility:** score motions, select stack, resolve which agents and tools are active for a tenant.

**Inputs (scorer):**
- Onboarding answers
- CRM snapshot (deal count, ACV, cycle length)
- Product telemetry availability flags
- Founder content capacity (LinkedIn cadence, newsletter history)
- Budget ceiling
- Category search demand (pulled via SmarterMCP search tool)
- Community density signals (Reddit/Slack activity in ICP subreddits)

**Scoring function:** deterministic multi-factor with published weights. Not LLM-generated. Version-stamped (`scorer_version`) so we can re-score historical inputs against new weights.

**Interface:**

```typescript
interface MotionEngine {
  scoreTenant(tenantId: string, inputs: MotionScoringInputs): Promise<MotionScore>;
  selectStack(tenantId: string, score: MotionScore, overrides?: FounderOverrides): Promise<MotionStack>;
  resolveAgents(tenantId: string, stack: MotionStack): Promise<AgentPlan>;
  resolveTools(tenantId: string, stack: MotionStack): Promise<ToolAllowlist>;
  resolveSkills(tenantId: string, stack: MotionStack): Promise<SkillManifest>;
}
```

**Re-scoring:** triggered by onboarding completion, cron (30-day, quarterly), significant events (pricing change, ICP edit, motion underperformance flagged by Learning Director). Never silent — a re-score produces a new `motion_scores` row + proposed `motion_stack` change that requires approval if it differs materially from the active stack.

### 6.2 Signal Router (always-on worker)

This is the component that separates "scheduled automation tool" from "operating system." A competitor's pricing change loses value by the hour; we do not wait for tomorrow's 06:00 sweep.

**Pipeline:**

```text
Signal sources                      Signal Router worker                       Dispatch
─────────────                       ─────────────────────                      ────────
webhook (CRM reply)    ──┐                                                    ┌── paperclip.wakeup
webhook (Stripe)       ──┤          ┌──────────────┐   ┌───────────────┐     │     (agent heartbeat)
webhook (Intercom)     ──┼──► Redis │ ingest       │─► │ classify      │     ├── paperclip.issue.create
cron (intel sweep)     ──┤  Stream  │ (dedupe,     │   │ (LLM or rules)│     │     (queued work)
scraper (competitors)  ──┤          │  validate)   │   └──────┬────────┘     │
GEO probe result       ──┤          └──────────────┘          │              └── digest email (low urg)
approval reject event  ──┘                                    ▼
product event stream   ──┐                             ┌──────────────┐
                          │                            │ urgency +    │
                          │                            │ half-life    │
                          │                            │ motion match │
                          │                            └──────┬───────┘
                          │                                   │
                          │                            ┌──────▼───────┐
                          └──► Redis stream            │ agent resolve│
                                                       └──────┬───────┘
                                                              │
                                                              ▼
                                                       dispatch.queue
```

**Classifier:** a two-stage design. Stage 1 is rule-based (regex + schema checks on known webhook shapes); it handles ~80% of events at ~$0 LLM cost. Stage 2 is a small LLM call for ambiguous events, with its result cached by signal shape.

**Urgency tiers:**

| Urgency | Half-life | Action |
|---|---|---|
| P0 (critical) | 30 min | immediate `paperclip.wakeup` on target agent with `priority=urgent` |
| P1 (high) | 2 hr | wakeup on target agent, normal priority |
| P2 (normal) | 24 hr | queued issue creation for next heartbeat |
| P3 (low) | 7 d | aggregated into founder digest or weekly review |

**Dedupe:** `dedupe_key` on `signal_events` prevents double-counting. Example: HubSpot emits the same event to both webhook and API poller; the router de-dupes by `(tenant_id, source_entity_id, event_type)`.

**Backpressure:** if the dispatch queue has > 500 jobs waiting per tenant, the router demotes P1 → P2 for non-commercial signals and surfaces an alert.

### 6.3 Confidence Scorer + Self-Critique

The confidence scorer is a *library* invoked synchronously at output time, but the self-critique step (second LLM pass) is an *async job* to keep initial latency tolerable.

**Flow:**

```text
Agent produces structured output
           │
           ▼
┌──────────────────────┐
│ Fast scoring         │   ← runs in-process, ~5ms
│ · structural checks  │     · schema validated?
│ · policy checks      │     · claims all verified?
│ · brand rules        │     · tone match founder_voice memory?
└──────────┬───────────┘
           │ (score_fast + risk_tier_provisional)
           ▼
┌──────────────────────┐
│ Enqueue critique     │
│ critique.queue       │
└──────────┬───────────┘
           │
           ▼   (async, 2-10s)
┌──────────────────────┐
│ Self-critique LLM    │   ← different model / prompt than producer
│ · fit to ICP         │
│ · evidence strength  │
│ · novelty vs losers  │
│ · factuality probe   │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ Composite score      │
│ · weighted combine   │
│ · auto_eligible flag │
│ · risk_tier finalize │
└──────────┬───────────┘
           │
           ▼
Emit output.confidence.scored
 → Paperclip execution_policy stage decides approval vs auto-dispatch
```

**Factor weights are per-output-type** (blog draft vs outbound touch vs lifecycle nudge each have different rubrics) and are themselves stored in `playbook_versions` with `artifact_type='policy'`, so Learning Director can propose weight changes.

**Auto-approve threshold:** starts at 1.0 (effectively off) for all founders. Founders unlock it per output-type per risk-tier after seeing 30+ accurate predictions. This is a *product gesture*, not just a technical toggle — it's how we earn the trust described in §15.6 of the strategic spec.

### 6.4 Experiment Manager

Experiments are first-class citizens, not side effects of content generation.

**Variant generation:** an agent proposes variants structured as `{variant_a, variant_b, hypothesis, metric_name, min_sample_size}`. Proposals require founder approval before becoming `running`.

**Traffic assignment:** deterministic hash of `(experiment_id, unit_id)` into [0, 1) against `traffic_split`. No cookies, no RNG — experiments must be reproducible.

**Evaluation:** nightly job computes per-variant stats. Uses a Bayesian framework (Beta-Binomial for conversion metrics, NormalGamma for continuous) — not frequentist p-values. Declares a winner when P(better) > 0.95 *and* sample size > `min_sample_size` *and* practical effect size > floor.

**Promotion:** winning variant is written as a `playbook_versions` bump, emitting `playbook.updated`, which triggers Skills Resolver to use the new version on next invocation. Creates a corresponding `gtm_learnings` row in `candidate` state.

**Anti-poisoning guards:**
- No experiments during known-anomalous windows (flagged holidays, outages, founder-on-vacation periods — set in memory).
- Minimum observation period per experiment-type to absorb day-of-week effects.
- Segment-balanced check: winner must hold across top 2 segments, not just in aggregate.

### 6.5 Learning Director pipeline

The single most important loop. If this doesn't run, the product is just scheduled automation.

```text
event.outbox
    │
    │  (performance.observed, output.rejected, experiment.concluded, lifecycle.stage.changed, ...)
    ▼
┌─────────────────────┐
│ Learning ingester   │   (consumes outbox, buckets by motion + agent + pattern_type)
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Evidence aggregator │   (windows, baseline, segment splits)
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Candidate synthesizer│  ← LLM, structured output, cites evidence_count + impact_delta
└──────────┬──────────┘
           │  writes gtm_learnings with status='candidate'
           ▼
┌─────────────────────┐
│ Validator           │   · min evidence count met?
│                     │   · baseline comparison significant?
│                     │   · no anomaly window overlap?
│                     │   · not contradicting a recent 'active' learning of higher confidence?
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Skill update proposal│  ← generates a diff against current playbook_versions
└──────────┬──────────┘
           │
           ▼
     Approval gate
     (Paperclip approvals + founder UI: diff view + evidence)
           │
           ├─ approved  → status='active', bump playbook_versions, emit learning.activated
           ├─ rejected  → status='rejected', add to avoid-list for similar patterns
           └─ deferred  → stays candidate; re-validated on next cycle

Revalidation loop (weekly):
  · touch last_validated_at on learnings whose evidence still supports them
  · expire learnings whose evidence has eroded or ttl_days exceeded
```

**Cadence:** event-driven candidate creation + weekly batch for revalidation and proposals. Founder sees "3 learning proposals this week" in the weekly review — not a noisy daily drip.

**Global cross-founder learnings** require two additional guards:
1. **Aggregation minimum:** must have ≥ N tenants (N ≥ 5) contributing before any global learning can be proposed.
2. **Anonymization:** stored without pointers to source tenants; evidence is segment-shaped, not text-shaped ("comparison content outperformed thought leadership in B2B devtools with ACV 5-20k" — never the actual text).

### 6.6 Warmth Builder

Default posture: no cold outbound in 2026. Every outbound sequence agent checks warmth first.

**Warmth score (0.0–1.0):**

```text
warmth = clamp(Σ weight_i * decay(t - touch_time_i), 0, 1)

Weights:
  linkedin_view                0.05
  linkedin_like                0.10
  linkedin_comment             0.20
  content_read                 0.15
  content_read_deep (>60s)     0.25
  webinar_attend               0.35
  reply                        0.50
  mutual_connection_intro      0.30
  meeting_taken                1.00

Decay: exp(-Δt / half_life); half_life varies by touch type (30-90 days).
```

**Builder actions (scheduled per prospect):** auto-engage (like, comment thoughtfully) with the prospect's own content, ensure the founder's content reaches their feed via targeted distribution, schedule content-engagement reciprocation. All touches are themselves P2 actions requiring approval the first N times per founder until trust is established.

**Gate into outbound:** a prospect must have `warmth_score ≥ 0.3` OR the founder has explicitly set `cold_override=true` for that campaign. Attempting to dispatch a P3 outbound touch below threshold fails at the SmarterMCP DLP layer, not silently.

### 6.7 GEO Monitor

Inbound is no longer just SEO. 40% of B2B discovery starts in AI search. We probe.

**Prompt library:** per tenant, we generate 20–50 prompts on onboarding based on their positioning (comparison, how-to, recommendation, definition intents). Stored in `geo_prompts`.

**Probe cadence:** daily for high-priority prompts, weekly for long-tail. Each probe hits ChatGPT-search, Perplexity, Google SGE, and Claude search (as available via SmarterMCP tool pack).

**Tracking:**
- Am I cited? At what rank?
- Which URL of mine is cited?
- Which competitors are cited when I am not?
- Does the answer snippet accurately represent my positioning?

**Feedback into Inbound agent:** GEO gaps (queries where competitors cite but we don't) become high-priority content briefs. This is the GEO-as-not-add-on principle from the strategic spec operationalized.

### 6.8 Attribution Aggregator

**Not in v1 scope: unified marketing attribution.** Trying to solve attribution fully would eat the team. Instead, v1 does *actionable attribution*:

- Multi-touch path reconstruction for deals that became opportunities (last 60 days of touchpoints).
- Per-content-piece assisted-conversion count (was this blog part of the journey for any converted lead?).
- Per-outbound-sequence reply and meeting-source breakdowns.

No attribution model (linear, time-decay, Shapley) is applied in v1 — we show the raw path and let the founder interpret. Confidence and caveats are first-class in the UI.

### 6.9 Lifecycle Engine

Deterministic state machine per user/account with configurable stage definitions. Not an agent — a scheduled service.

```text
aware ─signup──▶ activated ─usage_depth_met──▶ converted ─payment──▶ retained
                                                                       │
                                                             usage_drop│
                                                                       ▼
                                                                    at_risk ─recover──▶ retained
                                                                       │
                                                             inactivity│
                                                                       ▼
                                                                     churned

Stage transitions emit lifecycle.stage.changed events → Lifecycle Operator agent gets
context + recommended nudge type (activation email, save-play draft, expansion intro).
```

Stage rules are stored in `memory_items` with `kind='lifecycle_rules'` so they are tenant-configurable and version-tracked.

---

## 7. Agent architecture

### 7.1 The agent contract

Every GrowthOS agent is defined by five things:

```yaml
agent_id: inbound_content_strategist
motion: inbound
role: content_strategist
triggers:
  scheduled:
    - cron: "0 9 * * 1-5"   # weekdays 9am local
      reason: content_plan_check
  events:
    - output.approved:
        where: { output_type: content_brief }
    - signal.classified:
        where: { kind: competitor.content_published }
skill_manifest: skills/inbound/content_strategist@active
memory_scopes:
  - global:founder_voice
  - global:messaging_matrix
  - motion:inbound:claims_verified
  - motion:inbound:learnings_active
  - agent:self:recent_outputs
tools:
  required: [research.web, content.cms, analytics.read]
  optional: [research.social]
outputs:
  content_brief: { schema: content_brief.v1, risk: P0 }
  blog_draft:    { schema: blog_draft.v1,    risk: P2 }
  social_derivative: { schema: social_derivative.v1, risk: P2 }
```

Agent definitions live in version-controlled YAML in the repo, compiled into Paperclip `agents` rows on deployment. Skill manifests are a separate versioned artifact (§7.2).

### 7.2 Skills Resolver

Skills are motion-indexed markdown files with a structured front-matter. The library is 10–15 platform-level files for v1:

```
skills/
  base/
    founder_voice.md
    brand_rules.md
    claims_handling.md
    handoff_contracts.md
  inbound/
    content_strategist.md
    geo_optimization.md
  community/
    community_operator.md
  outbound/
    warm_outbound_researcher.md
    warmth_builder.md
  lifecycle/
    lifecycle_operator.md
  partners/
    partner_scout.md
  intel/
    intel_director.md
    signal_classifier.md
  learning/
    learning_director.md
    experiment_designer.md
  reporting/
    reporting_director.md
```

Each file has:

```markdown
---
skill_id: inbound.content_strategist
version: 7
compatible_agents: [inbound_content_strategist]
required_memory: [founder_voice, messaging_matrix, claims_verified]
output_schemas: [content_brief.v1, blog_draft.v1]
experiments_can_modify: true
---

# Inbound Content Strategist

## Mission
...

## How to write a content brief
...

## Output contract
...
```

**Resolution at runtime:**

1. Load the *active* `playbook_versions` row for `(tenant, motion, 'skills', skill_id)`.
2. If none, fall back to the platform default (shipped in repo).
3. Apply any *experiment overrides* (a running experiment may inject a modified skill section for the test variant).
4. Inject the resolved skill content into the system prompt.

This is how learnings affect agent behavior without us touching code.

### 7.3 Memory Resolver

Memory is filtered by tenant, scope, motion, and recency. The resolver returns at most K items (K = 8 for v1, tunable per agent) ranked by semantic similarity to the current task + active `gtm_learnings` with status='active' + explicit scoped `memory_items`.

```typescript
interface MemoryResolver {
  resolve(ctx: {
    tenantId: string;
    motion: string;
    agentId: string;
    task: string;                // brief description / issue title
    requiredScopes: MemoryScope[];
    k?: number;
  }): Promise<MemoryBundle>;
}

interface MemoryBundle {
  learnings: GtmLearning[];     // active, motion-relevant, TTL-valid
  claims: ContentClaim[];       // verified only
  preferences: MemoryItem[];    // scoped founder preferences
  recent_outcomes: MemoryItem[]; // last N edits/rejections for this output type
  retrieved_at: Date;
  digest: string;               // one-line summary suitable for prompt injection
}
```

**What is never injected:**
- Learnings with `status != 'active'` (candidates are the Learning Director's concern, not the producer agent's).
- Claims with `verification != 'verified'`.
- Memory items past `effective_to`.
- Cross-tenant memory (except anonymized segment learnings the founder has opted into).

### 7.4 Handoff contracts (agent-to-agent)

All inter-agent handoffs are structured JSON against a registered schema. Never prose-only. Schemas live in `schemas/handoffs/` in the repo and are versioned.

Example: Intel Director → Inbound Strategist:

```json
{
  "handoff_type": "content_opportunity.v1",
  "from_agent": "intel_director",
  "to_agent": "inbound_content_strategist",
  "tenant_id": "t_123",
  "trigger_signal_id": "s_456",
  "topic": "deployment governance for MCP tools",
  "audience_hypothesis": ["engineering_manager", "platform_lead"],
  "evidence": [
    { "kind": "competitor_blog", "url": "...", "published_at": "..." },
    { "kind": "community_thread", "platform": "reddit", "url": "..." }
  ],
  "related_claims_ids": ["claim_789", "claim_790"],
  "gating": {
    "confidence_required": 0.65,
    "experiment_candidate": true
  },
  "target_metric": "qualified_organic_signups",
  "created_at": "2026-04-22T10:00:00Z"
}
```

Handoffs are delivered by creating a Paperclip issue with `parentId` pointing to the trigger issue, `assigneeAgentId` set to the target, and the handoff JSON stored as an issue document with `key='handoff'`. The receiving agent picks it up via its inbox on next heartbeat.

---

## 8. Workflow patterns

### 8.1 When we pick workflow vs agent

Per the strategic spec, but concretely:

**Workflow (deterministic TS code):**
- All scheduling, webhook ingestion, signal classification rules (stage 1)
- Confidence scoring composition
- Experiment stats and promotion
- Lifecycle stage transitions
- Cost aggregation
- Attribution path reconstruction
- Dispatch to external systems (with idempotency keys)
- Approval routing

**Agent (LLM call):**
- Intel Director synthesis
- Content brief and draft generation
- Outbound personalization
- Community reply drafting
- Self-critique
- Learning synthesis (candidate generation step)
- Signal classification stage 2 (ambiguous events only)

### 8.2 Durable execution

Every external action is expressed as a three-step durable unit:

```text
1. intent.recorded     → writes to activity_log + generates idempotency_key
2. dispatched          → SmarterMCP call with idempotency_key
3. confirmed | failed  → records provider's ack or DLQ on retry exhaustion
```

Retries use BullMQ exponential backoff. Retry policy per tool category:

| Category | Max retries | Strategy |
|---|---|---|
| Read-only (search, CRM read) | 5 | exp backoff 1-30s |
| Enrichment | 3 | exp backoff 5-60s |
| Writes (CRM write, content publish) | 2 | careful backoff 30s-5min |
| External send (email, post) | 0 retries post-send | one attempt, confirm or DLQ |

**Compensation:** internal state changes are rolled back on dispatch failure. External sends are never compensated (you cannot unsend an email); we log and escalate.

### 8.3 State machine for risky external action

Directly maps to Paperclip `executionPolicy.stages`:

```text
issue.status flow for a P2/P3 output:

backlog ─agent_picks─▶ in_progress ─agent_emits_output─▶ in_review (confidence gate)
                                                            │
                                                            ├─ critic_passes  → in_review (human approver)
                                                            │                      │
                                                            │                      ├─ approved → done → dispatched
                                                            │                      └─ changes_requested → in_progress
                                                            │
                                                            └─ critic_fails   → in_progress (revise)
```

Paperclip's native review/approval transitions give us this for free. We add a custom `pre_review` stage implemented as an `executor:growthos.confidence_gate` stage that the critique worker completes.

---

## 9. Policy & Approval pipeline

### 9.1 Tier → Paperclip mapping

```yaml
P0_internal:
  paperclip_policy: { stages: [] }   # no review

P1_moderate:
  paperclip_policy:
    stages:
      - type: review
        participants: [{ type: agent, agentId: reporting_director }]
        optional: true

P2_public:
  paperclip_policy:
    stages:
      - type: review
        executor: growthos.confidence_gate
      - type: approval
        participants: [{ type: user, role: founder }]
        sla_hours: 24

P3_commercial:
  paperclip_policy:
    stages:
      - type: review
        executor: growthos.confidence_gate
      - type: review
        executor: growthos.warmth_gate        # P3 only
      - type: approval
        participants: [{ type: user, role: founder }]
        sla_hours: 8

P4_sensitive:
  # Not dispatched by agents. Agent produces draft, human owns.
  paperclip_policy:
    stages:
      - type: approval
        participants: [{ type: user, role: founder }]
        human_must_edit: true
```

Custom executors (`growthos.confidence_gate`, `growthos.warmth_gate`) are registered with Paperclip as stage executors. They run our logic and advance or reject the stage.

### 9.2 Approval telemetry → Learning

The `approval_feedback` table captures every decision the founder makes. Every row flows into the Learning Director pipeline:

- approved, edit_distance < 0.1 → positive evidence for the producer's current skill version
- edited_then_approved, edit_distance ≥ 0.1 → structured diff analyzed for learnable patterns
- rejected, rubric_failures not empty → contributes to avoid-list for that pattern_type

**Edit diff analysis:** we run a focused LLM pass on the before/after to extract structured edit categories (tone shift, claim removal, format change, etc.). These feed candidate learnings, not the raw diff.

### 9.3 Auto-approve maturation

One of the product's growth loops. Per output-type per tier:

```text
auto_approve_eligible iff:
  · last 30 outputs in this (type, tier): ≥ 27 approved, ≤ 3 edited (edit_distance < 0.15), 0 rejected
  · confidence score median ≥ 0.85 on those 30
  · no negative incidents (risk.blocked events) attributable to this agent in 60d
  · founder explicitly unlocked auto_approve for this (type, tier)
```

Even when eligible, a small random fraction (5–10%) stays routed to human approval to keep the oversight signal alive.

---

## 10. Skills library, costs, and operational concerns

### 10.1 Skills library structure (v1, 10–15 files)

Listed in §7.2. Storage pattern: canonical in git repo under `skills/`, compiled at deploy into platform defaults. Per-tenant overrides live in `playbook_versions` table. A tenant-specific skill override has the full markdown content, so a founder can diverge completely if desired (experiments do this automatically for variants).

### 10.2 Cost model

Four cost axes per tenant per month:

1. **LLM tokens** (producer + critic + classifier + synthesizer)
2. **Third-party data** (Apollo enrichment, search credits, GEO probes)
3. **Paperclip infra amortization** (Postgres, Redis, workers)
4. **External sends** (email domains, LinkedIn seat, social API quotas)

**Budget enforcement:**
- Paperclip's `agent.budgetMonthlyCents` is the per-agent soft ceiling.
- `cost_events` aggregates actuals. Worker checks remaining budget before expensive actions; at 90% a warning issues to founder; at 100% non-P0 work is paused for that agent.
- SmarterMCP per-tenant quota enforces a hard ceiling even if workers fail to check.

**Expected v1 tenant unit economics (rough):**

| Line | Monthly cost (early) |
|---|---|
| LLM (GPT-4o-class for producers, smaller for critic/classifier) | $60–150 |
| Third-party data | $30–80 |
| Infra amortized (share of shared stack) | $5–15 |
| External send (founder's own account, mostly) | $0–30 |
| **Total COGS per active tenant** | **$100–280** |

This is the unit cost that determines the floor on pricing. §12 of the strategic spec is right to pivot away from per-agent pricing — it hides this cost from the customer.

### 10.3 External send rate limits

Hard-coded per channel, enforceable at SmarterMCP and reinforced in our dispatch queue:

| Channel | Per tenant per day | Per subject per week |
|---|---|---|
| email (warm outbound) | 50 | 1 |
| LinkedIn DM | 20 | 1 |
| LinkedIn engagement (like/comment) | 50 | 3 |
| community reply (Reddit/Slack) | 20 | — |
| social post | 5 | — |
| lifecycle in-app | unbounded policy-approved | per lifecycle rule |

These are v1 ceilings. Founders can raise, never above platform maxes, subject to deliverability health checks.

---

## 11. Founder surfaces (product layer)

### 11.1 Onboarding wizard (5 steps, retained from v2)

1. **Company basics** — name, domain, logo, product description, stage.
2. **Product & market intake** — positioning draft, ICP hypothesis, top 3 competitors, pricing, top 5 claims.
3. **Signal/data sources** — connect CRM, analytics, email provider, CMS, LinkedIn.
4. **Motion scoring review** — auto-generated motion scores presented with rationale + what inputs drove each. Founder confirms/edits.
5. **Policy preferences** — approval SLA per tier, auto-approve starting posture (all off), brand voice sample (5 paragraphs of existing founder writing).

Completion emits `motion.stack.selected` and `tenant.onboarded`, which triggers the first daily intel sweep and weekly review cadence.

### 11.2 Dashboard information architecture

```
┌── Home (today view)
│   ├── Approval queue (default filter: pending, sorted by SLA + risk)
│   ├── Today's highlights (generated by Reporting Director)
│   └── Alerts (risk.blocked, budget warnings, signal urgency P0)
│
├── Motions
│   ├── Stack view (active/secondary/observe/deactivated)
│   ├── Motion detail per motion (agents, running experiments, recent outputs, health)
│   └── Re-score history + proposed changes
│
├── Approvals
│   ├── Queue (with confidence + risk + evidence + diff editor)
│   ├── History (filterable by agent, motion, outcome)
│   └── Learn/not-learn toggle per item
│
├── Experiments
│   ├── Running
│   ├── Concluded (winners + learnings derived)
│   └── Proposed (awaiting approval)
│
├── Playbook
│   ├── Skills (per motion, versioned, with diff from platform default)
│   ├── Claims library
│   ├── Messaging matrix
│   └── Change log
│
├── Weekly Operating Review (Monday)
│   └── Generated Sunday night, contains: motion health, bottlenecks, proposed next-week priorities, playbook changes
│
├── Intel & Signals
│   ├── Live signal feed (with urgency)
│   └── Intel briefs (daily)
│
├── Lifecycle (when lifecycle motion active)
│   └── Stage funnel, at-risk accounts, active save plays
│
└── Settings
    ├── Connections, team, billing (Stripe), notifications, brand assets
    └── Policy tiers, auto-approve controls, do-not-send lists
```

### 11.3 Approval queue UX contract (non-negotiable)

Every item shows:

- confidence score (0–1, with factor breakdown on hover)
- risk tier (P0–P4, color coded)
- source evidence (clickable list — content brief, signals, claims used)
- experiment membership (variant A/B if in experiment)
- generation reason ("generated now because …")
- diff view after any edit (learns from the diff)
- learn/not-learn toggle (founder can suppress learning for ad-hoc overrides)

**Do not mix tiers in one scroll.** The queue defaults to grouped-by-tier so the founder's attention is directed.

### 11.4 Founder digest email

Daily if there is anything to report, weekly if quiet. Content:

- approvals needed (top N by risk × urgency)
- P0/P1 signals of last 24h
- experiments reaching significance
- learning proposals ready for review
- budget status

Short. Linkable. Mobile-readable. No digest if no substantive items.

---

## 12. Observability

### 12.1 Three planes

**Traces:** OpenTelemetry, propagated through api → worker → SmarterMCP → upstream. Trace IDs carried in Paperclip `X-Paperclip-Run-Id` header; SmarterMCP includes them in its audit events. One click in the founder-facing run detail shows the full trace: LLM calls, tool calls, DLP decisions, DB mutations, cost events.

**Metrics (Prometheus):**
- per-queue: depth, consume rate, failure rate, p50/p95/p99 processing latency
- per-agent: heartbeat success %, cost/day, output count by type, approval rate
- per-tenant: signal classification latency, approval queue depth, experiment count
- system: DB connections, Redis memory, RLS enforcement rate (must be 100%)

**Logs:** structured JSON, tenant_id always present, shipped to a log aggregator. Per-tenant log retention 90 days hot.

### 12.2 Audit trail (immutable)

The canonical audit view is a union over:
- `paperclip.heartbeat_runs` + events
- SmarterMCP audit trail (joined by run_id)
- `growthos.activity_log` (partitioned)
- `growthos.approval_feedback`

Exposed via a single `/api/audit` endpoint, tenant-scoped, cursor-paginated, and as an export (JSON + CSV) for compliance.

### 12.3 Key SLIs / SLOs (v1)

| SLI | SLO |
|---|---|
| Signal → first agent dispatch (P0 signals) | < 60s p95 |
| Approval queue page load | < 800ms p95 |
| Heartbeat run completion | < 30s p95 |
| Self-critique completion | < 15s p95 |
| Dispatch → confirmation | < 5min p95 |
| Cross-tenant data leakage incidents | 0 |
| Auto-approve incorrect-promotion rate | < 1% of auto-approved actions |
| Live-event fan-out latency (outbox commit → WS delivered) | < 500ms p95 |
| WS reconnect with zero-gap backfill success rate | > 99.5% |
| `outbox-relay` lag (unconsumed event age) | < 2s p95, < 30s p99 |
| Redis Pub/Sub outage degraded-mode recovery | < 10s to polling fallback |

---

## 13. Security & Tenancy

### 13.1 Tenant boundary enforcement, layered

1. **Clerk** authenticates users; organization membership = tenant membership.
2. **API gateway** resolves tenant from Clerk session, sets `app.tenant_id` and `app.actor_*` on the DB connection.
3. **Postgres RLS** enforces at query time. `FORCE ROW LEVEL SECURITY` on every tenant-scoped table.
4. **SmarterMCP** maintains its own tenant scoping at the tool layer.
5. **Redis keys** are all `t:{tenant}:...` prefixed; a separate key-prefix linter runs in CI.
6. **Object store** uses per-tenant prefixes + signed URL scoping.

A breach in any one layer does not yield cross-tenant data. We test this with a quarterly red-team: give a test agent a malformed tenant context and verify nothing leaks.

### 13.2 Secrets

Per-tenant API keys (HubSpot, analytics, LinkedIn session tokens) live encrypted at rest with per-tenant KMS keys. Plain text never enters logs. Workers load secrets via SmarterMCP's tenant credential service, not direct env vars.

### 13.3 PII handling

The DLP layer in SmarterMCP redacts PII from scraped responses before they reach the model prompt. Stored long-term only in CRM-mirror indices with per-field classification. Right-to-erasure (GDPR): a tenant-scoped erasure job scrubs `memory_items`, `activity_log`, and archived `cost_events` where applicable.

---

## 14. Deployment

### 14.1 Stack

- **Runtime:** Node.js 22, TypeScript, Fastify + Next.js (App Router)
- **DB:** Postgres 16 + pgvector + pg_partman, on Supabase (v1) or managed RDS (scale-out)
- **Cache/Queue:** Redis 7 (ElastiCache or Upstash)
- **Workers:** Node, deployed as independent services on Fly.io / Railway / ECS
- **Object store:** Cloudflare R2 or S3
- **Auth:** Clerk
- **Billing:** Stripe + Stripe entitlements (maps plan → motion feature flags)
- **Email:** Resend for transactional + founder digest
- **Observability:** Grafana Cloud or Datadog; OpenTelemetry everywhere

### 14.2 Environments

- `dev` — single developer, embedded Postgres, local Redis, mock SmarterMCP.
- `staging` — shared, real SmarterMCP against sandboxed upstreams, synthetic tenants.
- `prod` — multi-tenant, real SmarterMCP, real upstreams.

Migrations run via `paperclip` schema and `growthos` schema separately; Paperclip schema migrations are vendored with our hardening deltas applied on top.

### 14.3 Blast radius discipline

- One runaway tenant cannot exhaust shared queues: BullMQ per-tenant rate limits.
- One bad LLM prompt cannot exhaust LLM budget: per-agent cost cap + SmarterMCP session budget.
- One bad migration cannot nuke multi-tenant data: migrations that touch tenant data require a dry-run on a cloned shadow DB first.
- One hot tenant cannot saturate the Pub/Sub bus: tenant-prefixed channels mean subscribers only pay for channels they care about, and per-channel publish rate is capped at the relay (deduping bursts within 50ms windows).
- Pub/Sub outage cannot stop the product: the outbox is the contract; workers keep consuming the table directly, and the UI degrades to polling within 10s.

---

## 15. Phased delivery (aligns with `Growthos_v4.md` §16)

### Phase 1 — Prove trustworthy compression (weeks 1–10)

Engineering priorities, in order:

1. Fork Paperclip, ship RLS migration, ship BullMQ scheduler replacement, enable Redis cache, partition `activity_log` and `cost_events`, replace `LiveEventsServer` with Redis Pub/Sub fan-out via `outbox-relay` (§3.1–§3.6). (hardening first — nothing else works without it)
2. SmarterMCP tenant provisioning + tool packs + custom adapter.
3. Motion Engine (scorer, stack selector, agent resolver, skills resolver) + skills library v0.
4. Agents: Intel Director, Inbound Content Strategist, Reporting Director.
5. Confidence Scorer (fast-path only, critique async).
6. Approval queue UX with diff capture + `approval_feedback` pipeline.
7. Onboarding wizard (5 steps).
8. Weekly operating review.
9. Founder digest.

**Phase 1 exit criteria:** a founder onboards, has their motions scored, gets approved content drafted for inbound, sees a weekly review with real data, and `approval_feedback` rows are being written.

### Phase 2 — Prove compounding value (weeks 11–20)

1. Experiment Manager end-to-end (variant proposal → running → evaluation → promotion).
2. Learning Director pipeline (candidate → validator → proposal → playbook update).
3. Signal Router (real-time inbox → classify → dispatch).
4. Warm Outbound Researcher + Warmth Builder.
5. GEO Monitor + GEO-aware inbound skill.
6. Lifecycle Operator + Lifecycle Engine.
7. Playbook versioning UI + learning approval UX.

**Phase 2 exit criteria:** at least one tenant with a complete loop — experiment run, winner promoted, playbook bumped, subsequent outputs measurably better. Learning decay and revalidation cycle running.

### Phase 3 — Prove operating leverage (weeks 21+)

1. ABM Planner, Customer Expansion Analyst, Launch Orchestrator.
2. Multi-user approvals, roles, team seats.
3. Segment benchmark priors (v2 of learning with cross-founder global scope).
4. Revenue Leak Investigator.
5. Richer attribution (path analysis, not models).
6. Partner co-selling / co-marketing orchestration.

---

## 16. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Paperclip upstream diverges hard, RLS patch won't rebase cleanly | High | High | Weekly merge cadence; RLS implemented as orthogonal layer (new column + policies) that rarely conflicts with logic changes |
| Learning Director proposes bad playbook changes that compound | Medium | Critical | Approval gate on every skill update; ttl_days + revalidation; ability to roll back any playbook version |
| Signal Router floods on a bad webhook source | Medium | Medium | Per-tenant rate limit, dedupe, backpressure demotion |
| LLM costs blow past budget | Medium | Medium | SmarterMCP session cap + agent budget + cost_events monitoring + auto-pause at 100% |
| SmarterMCP becomes single point of failure for all external I/O | Medium | High | SmarterMCP deployed HA; fallback "direct mode" for read-only tools under break-glass; circuit breakers in our adapter |
| Confidence scores become uncalibrated, founders lose trust | Medium | Critical | Monthly calibration report comparing predicted confidence vs observed outcome; recalibration of weights; conservative auto-approve unlock |
| Warmth gate becomes a bottleneck, founder goes to cold by default | Medium | Medium | Fast path: founder content distribution + auto-reciprocation seeds warmth without per-prospect approvals; P2 auto-approve for warming touches after trust built |
| Global cross-founder learning leaks tenant data | Low | Critical | Minimum aggregation size; structural enforcement in pipeline; no free-text fields in global learnings |
| Approval queue fatigue | High | High | Auto-approve maturation; batched approvals; smart defaults; focus on reducing items that *need* review rather than making them faster |
| Redis Pub/Sub outage silently drops live events | Low | High | Outbox is the contract, not Pub/Sub; WS gateway detects via heartbeat on channel and degrades to polling with a UI banner; `outbox_relay_lag_ms` alert pages oncall |
| `outbox-relay` leader split-brain publishes duplicates | Low | Medium | Single Redis lock for leader; publishers use `consumed_at` CAS update to de-dupe; consumers dedupe on `event_outbox.id` |
| WebSocket connection flood (tab-explosion, malicious client) | Medium | Medium | Per-tenant WS connection cap, per-IP rate limit, presence TTL auto-expires zombie connections |

---

## 17. Biggest single thing to get right

The strategic spec (§15.6) names it: **founder trust through measurable, reversible, evidence-backed execution.**

Technically, that comes down to three invariants the whole architecture enforces:

1. **Nothing goes out without a risk tier and a confidence score.** No action bypasses the pipeline.
2. **Every action is reversible or escalated.** Internal state is reversible; irreversible external actions (public posts, emails) require tier-appropriate approval and are rate-limited.
3. **Every outcome flows back into memory.** Approvals, edits, rejections, experiments, and conversions all write to typed memory within 60 seconds. If this loop breaks, the product stops compounding.

If those three are true, v4 is an operating system. If any one is false, it's orchestration theater.

---

## 18. Test strategy

Testing is not an afterthought here — several product invariants (tenant isolation, confidence calibration, claims verification, irreversibility of external sends) are **only safe if tested**. This section specifies the test suites, the tools, and the CI gates. Every suite lists concrete example test names so an engineer can start writing them tomorrow.

### 18.1 Testing principles

1. **Tests defend invariants, not implementations.** If a refactor preserves the invariant, the test should still pass.
2. **Cross-tenant isolation is P0.** Every PR runs the RLS suite. A single failure blocks merge, no exceptions.
3. **LLMs are clamped in tests.** Producer LLMs are replaced with deterministic stubs that return fixtures. We test *prompt composition and output handling*, not the model itself. A separate offline eval suite (§18.11) tracks model quality.
4. **Time is injectable.** No test calls `Date.now()` directly. All services take a `Clock` dependency so time-based behavior (TTL, decay, experiment windows) is testable in milliseconds.
5. **Flaky tests are bugs.** A test that passes on retry is broken and gets a P1 issue. We do not retry-until-green in CI.
6. **Production parity in staging.** Staging runs the full stack including SmarterMCP (sandboxed upstreams) and real Postgres/Redis. No "mocked SmarterMCP in staging."

### 18.2 Test pyramid and coverage targets

| Layer | Count (target v1) | Runtime budget | Coverage metric |
|---|---|---|---|
| Unit (§18.3) | ~1,200 | < 60s total | 85% line on domain code, 100% on scoring/classifier/policy functions |
| Contract (§18.4) | ~60 schemas × 5 each = ~300 | < 30s | 100% of registered handoff/output schemas |
| Integration (§18.5) | ~120 | < 8 min | every cross-service seam has ≥ 1 happy + ≥ 1 failure |
| RLS / tenant isolation (§18.6) | ~80 | < 2 min | every tenant-scoped table has positive + negative case |
| End-to-end (§18.7) | ~15 | < 20 min | Appendix B sequence + every phase-exit scenario |
| Security (§18.8) | ~40 | < 5 min | every auth surface, DLP tier, claims-verification path |
| Load (§18.9) | 6 scenarios | nightly, not blocking | every SLO has a load test |
| Chaos (§18.10) | 8 scenarios | weekly, not blocking | every HA claim in this doc |
| Data quality / offline eval (§18.11) | continuous | daily batch | confidence calibration, learning decay, experiment stats |

### 18.3 Unit test suites (per module)

Tools: Vitest, ts-mockito, `@faker-js/faker`, `pg-mem` for schema-only tests, `jest-extended` matchers.

**Motion Engine (`motion-engine/`):**

```text
motion-scorer.spec.ts
  · scores_are_deterministic_for_identical_inputs
  · inbound_score_dominates_when_category_search_demand_is_high
  · outbound_score_reduced_when_budget_is_below_floor
  · paid_motion_auto_deactivated_when_budget_is_zero
  · scorer_version_is_stamped_on_every_score
  · inputs_digest_changes_iff_inputs_change

motion-stack-selector.spec.ts
  · activates_motions_above_threshold_with_required_data_sources
  · demotes_to_observe_when_signal_is_promising_but_evidence_weak
  · requires_approval_for_high_risk_motion_activation
  · founder_override_wins_over_score_recommendation

agent-resolver.spec.ts
  · active_agents_match_motion_stack_primary_plus_secondary
  · deactivated_motions_disable_their_agents_in_single_tick
  · always_present_agents_remain_regardless_of_stack
```

**Signal Router (`signal-router/`):**

```text
classifier-stage1.spec.ts
  · matches_hubspot_reply_rule_to_prospect_replied_kind
  · dedupes_events_with_same_dedupe_key_within_tenant
  · does_not_cross_tenant_when_dedupe_keys_collide
  · emits_stage2_for_ambiguous_webhook_shape
  · respects_source_allowlist_per_tenant

classifier-stage2.spec.ts
  · llm_stub_classifies_golden_fixtures_deterministically
  · falls_back_to_unknown_kind_when_llm_confidence_below_threshold
  · caches_classification_by_signal_shape

urgency-scorer.spec.ts
  · competitor_pricing_change_scored_p1_with_2h_half_life
  · prospect_replied_scored_p0_with_30min_half_life
  · p1_demoted_to_p2_when_dispatch_queue_exceeds_500

dispatcher.spec.ts
  · enqueues_paperclip_wakeup_for_p0_within_one_tick
  · creates_queued_issue_for_p2_not_wakeup
  · emits_aggregated_digest_entry_for_p3
```

**Confidence Scorer (`confidence/`):**

```text
fast-scorer.spec.ts
  · structural_check_fails_when_schema_invalid
  · policy_check_fails_when_output_contains_unverified_claim
  · brand_check_fails_when_tone_diverges_from_founder_voice_sample
  · composite_is_weighted_combination_of_factor_scores
  · scorer_version_stamped_on_every_score
  · does_not_mark_auto_eligible_below_unlock_threshold_even_at_perfect_score

risk-tier-resolver.spec.ts
  · p0_assigned_to_internal_outputs_only
  · p2_assigned_to_any_public_channel_output
  · p3_assigned_to_outbound_commercial_dispatch
  · p4_cannot_be_produced_by_agent_path

critic.spec.ts
  · critique_runs_on_different_model_than_producer
  · critique_blocks_when_factuality_probe_fails
  · critique_attaches_run_id_to_confidence_score_row
```

**Warmth (`warmth/`):**

```text
warmth-math.spec.ts
  · warmth_decays_exponentially_at_configured_half_life
  · reply_weight_dominates_all_other_touches
  · warmth_clamps_to_one_on_meeting_taken
  · touches_before_ttl_are_ignored

warmth-gate.spec.ts
  · p3_dispatch_blocked_when_warmth_below_0_3
  · cold_override_allows_dispatch_above_audit_event
  · override_expires_at_campaign_end
```

**Experiments (`experiments/`):**

```text
bayesian-eval.spec.ts
  · declares_winner_when_posterior_exceeds_0_95_with_min_n
  · refuses_winner_when_segment_imbalanced
  · refuses_winner_when_observation_window_in_anomaly_period
  · returns_inconclusive_when_both_variants_perform_equally

promotion.spec.ts
  · winning_variant_bumps_playbook_version
  · emits_playbook_updated_event_with_change_source_experiment_id
  · creates_gtm_learnings_candidate_row_linked_to_experiment
```

**Learning Director (`learning/`):**

```text
evidence-aggregator.spec.ts
  · requires_min_evidence_count_before_candidate_created
  · baseline_comparison_uses_matched_window
  · excludes_anomaly_windows_from_baseline
  · segment_splits_block_overgeneralization

candidate-synthesizer.spec.ts
  · synthesizer_cites_evidence_count_and_impact_delta
  · synthesizer_refuses_to_propose_contradicting_higher_confidence_active_learning
  · output_passes_learning_schema_validation

revalidator.spec.ts
  · active_learnings_get_last_validated_at_bumped_on_supporting_evidence
  · learnings_past_ttl_without_revalidation_move_to_expired
  · superseded_learnings_are_not_revalidated
```

**Skills & Memory Resolver (`resolver/`):**

```text
skills-resolver.spec.ts
  · loads_tenant_active_version_when_present
  · falls_back_to_platform_default_when_no_tenant_override
  · applies_experiment_variant_for_assigned_traffic
  · does_not_leak_other_tenants_skill_versions

memory-resolver.spec.ts
  · returns_k_items_ranked_by_similarity
  · excludes_learnings_with_status_not_active
  · excludes_claims_with_verification_not_verified
  · excludes_memory_items_past_effective_to
  · never_returns_cross_tenant_items
```

**Paperclip hardening (`paperclip-fork/`):**

```text
scheduler-leader.spec.ts
  · only_one_instance_holds_leader_lock
  · failover_completes_within_3s_of_leader_death
  · follower_does_not_enqueue_jobs

cache-invalidation.spec.ts
  · patch_issue_invalidates_issue_cache_before_next_read
  · create_agent_invalidates_org_cache
  · confidence_score_read_never_served_from_stale_cache

partition-manager.spec.ts
  · new_monthly_partition_created_before_month_boundary
  · old_partitions_detached_after_18_months
  · query_on_recent_range_uses_partition_pruning

live-events-fanout.spec.ts
  · outbox_commit_triggers_pubsub_publish_within_500ms
  · ws_client_receives_event_from_instance_it_is_not_connected_to
  · ws_reconnect_with_last_seen_id_replays_only_missing_events
  · pubsub_outage_degrades_to_polling_within_10s
  · relay_leader_death_handed_off_without_duplicate_publishes
```

### 18.4 Contract tests (JSON schemas)

Every handoff and output schema is a versioned JSON Schema (Ajv-compiled). Contract tests:

```text
schemas/handoffs/content_opportunity.v1.spec.ts
  · accepts_minimal_valid_handoff
  · rejects_handoff_missing_evidence
  · rejects_handoff_with_unknown_target_agent
  · v1_payload_is_readable_by_v1_consumer
  · v1_payload_is_readable_by_v2_consumer_with_fallback_fields

schemas/outputs/blog_draft.v1.spec.ts
  · rejects_draft_containing_unverified_claim_id
  · rejects_draft_missing_cta
  · rejects_draft_with_banned_competitor_mention
```

**Rule:** a new schema version is never deleted; we keep v1 alive for at least one major release. A consumer reading v1 when v2 exists must gracefully handle the old shape.

### 18.5 Integration tests (cross-service seams)

Tools: Testcontainers (Postgres 16 + pgvector, Redis 7), real BullMQ, a fake SmarterMCP gateway (contract-tested against the real one nightly), Playwright for UI, `msw` for upstream HTTP.

**Seam: Heartbeat lifecycle**

```text
integration/heartbeat/
  · scheduler_enqueues_routine_on_cron_tick
  · worker_picks_up_job_and_creates_paperclip_run
  · run_emits_structured_output_and_advances_issue_status
  · duplicate_enqueue_with_same_idempotency_key_is_skipped
  · job_that_fails_5_times_ends_up_in_dlq
  · dlq_replay_with_founder_approval_succeeds
  · concurrent_workers_do_not_double_process_same_run
```

**Seam: Signal → action loop**

```text
integration/signal-to-action/
  · webhook_ingested_p1_signal_creates_agent_wakeup_in_under_5s
  · p0_signal_preempts_p2_in_dispatch_queue
  · dispatch_backpressure_demotes_p1_to_p2_when_queue_over_500
  · two_sources_emitting_same_event_are_deduped
```

**Seam: Confidence + approval + dispatch**

```text
integration/confidence-approval/
  · p2_output_routes_to_approval_queue_with_confidence_and_risk_tier
  · founder_edit_then_approve_writes_approval_feedback_with_edit_distance
  · reject_writes_rubric_failures_and_blocks_dispatch
  · auto_approve_ineligible_output_always_routes_to_human
  · auto_eligible_output_respects_5_percent_sampling_rule
```

**Seam: Approval → dispatch → external**

```text
integration/dispatch/
  · approved_content_cms_publish_call_goes_through_smartermcp
  · dlp_block_prevents_dispatch_and_surfaces_in_approval_queue
  · dispatch_failure_retries_with_exponential_backoff_read_only_tools
  · external_send_failure_never_retries_and_lands_in_dlq
  · idempotency_key_prevents_duplicate_send_on_replay
```

**Seam: Experiment → learning → playbook**

```text
integration/experiment-to-playbook/
  · winning_variant_promotes_playbook_version
  · playbook_bump_is_served_by_skills_resolver_on_next_run
  · learning_candidate_linked_to_experiment_requires_founder_approval
  · rejected_learning_adds_pattern_to_avoid_list
```

**Seam: Live events**

```text
integration/live-events/
  · two_api_instances_both_see_same_tenant_event
  · ws_client_on_instance_a_receives_event_published_from_instance_b
  · pubsub_outage_ui_falls_back_to_polling_within_10s_banner_shown
  · ws_reconnect_replays_gap_using_last_seen_event_id
  · outbox_relay_leader_failover_does_not_lose_events
```

**Seam: Paperclip fork hardening**

```text
integration/paperclip-fork/
  · bullmq_scheduler_replaces_in_process_timer_transparently_for_api_consumers
  · cache_invalidation_propagates_within_100ms_via_notify
  · activity_log_partition_rotation_occurs_automatically
  · cost_events_rollup_refreshes_every_5_minutes
```

### 18.6 RLS / tenant-isolation tests (P0, blocking)

This suite is non-negotiable. It is generated, not hand-written, so coverage cannot drift.

**Generator approach:**

```text
For every table with tenant_id:
  For every operation in {SELECT, INSERT, UPDATE, DELETE}:
    · positive: tenant A's session can operate on tenant A's rows
    · negative: tenant A's session cannot read tenant B's rows
    · negative: tenant A's session cannot INSERT with tenant_id = B
    · negative: tenant A's session cannot UPDATE a row to set tenant_id = B
    · negative: a session with no app.tenant_id set fails closed (no rows)
    · negative: a BYPASSRLS admin role can see cross-tenant but is logged

For every Redis key pattern:
  · cross-tenant key read fails (prefix linter)

For every S3 prefix:
  · signed URL for tenant A does not list tenant B objects
```

**Concrete named tests include:**

```text
rls/
  · rls_enforced_on_every_paperclip_table (property-based, iterates over pg_class)
  · rls_enforced_on_every_growthos_table
  · missing_session_tenant_returns_zero_rows_not_error
  · bypassrls_role_requires_separate_connection_pool
  · api_request_lacking_tenant_context_is_rejected_at_middleware
  · worker_job_without_tenant_context_fails_closed
  · redis_key_without_tenant_prefix_trips_ci_linter

cross-tenant-probes/
  · tenant_a_cannot_read_tenant_b_memory_items_via_direct_sql
  · tenant_a_cannot_read_tenant_b_confidence_scores
  · tenant_a_cannot_subscribe_to_tenant_b_pubsub_channel
  · tenant_a_cannot_invoke_tenant_b_smartermcp_session
  · tenant_a_cannot_retrieve_tenant_b_cached_response_via_content_hash_guess
```

CI: this suite runs on every PR. **A single failure blocks merge.**

### 18.7 End-to-end tests (the Appendix B loop, automated)

Tool: Playwright driving a seeded staging environment with synthetic tenants and LLM stubs.

```text
e2e/
  · full-loop-appendix-b.spec.ts
      walks the entire signal → intel → brief → draft → approve → publish → measure → learn → playbook flow
      assertion points at every t+N boundary
      runs in < 20 min

  · founder-onboarding-to-first-approval.spec.ts
      5-step wizard → motion scores → agent activation → first content brief → approval queue entry

  · cold-start-tenant-7-day-simulation.spec.ts
      fast-forwards time; asserts daily intel, weekly review, learning candidates emerge

  · disaster-recovery-restart-mid-flow.spec.ts
      kills all workers mid-run; confirms no dropped jobs, no duplicate external sends, UI catches up via WS backfill

  · multi-user-approval-concurrency.spec.ts
      two reviewers; one approves, one edits-and-approves; last-writer-wins is well-defined; diff is preserved
```

### 18.8 Security tests

```text
security/auth/
  · clerk_session_without_org_membership_is_rejected
  · expired_session_returns_401_before_any_db_query
  · stripe_webhook_hmac_signature_mismatch_rejected

security/dlp/
  · p3_send_containing_unverified_claim_is_blocked_by_smartermcp
  · p2_post_containing_banned_competitor_name_is_blocked
  · pii_in_scraped_response_is_redacted_before_model_sees_it
  · prompt_injection_in_scraped_page_does_not_escalate_privileges

security/claims/
  · claim_marked_pending_cannot_appear_in_p2_plus_output
  · claim_past_valid_until_is_auto_retired
  · claim_edit_by_agent_requires_human_approval

security/secrets/
  · tenant_api_keys_never_appear_in_logs
  · kms_key_rotation_does_not_break_in_flight_jobs
  · failed_upstream_auth_does_not_leak_credential_in_error_response
```

### 18.9 Load and performance tests (SLO-backed)

Tool: k6 against a dedicated perf environment. Runs nightly; results tracked over time; regressions page oncall.

```text
load/
  · signal-burst-1000-per-tenant.js
      target: 100 tenants × 10 signals/s for 5 min
      SLO: P0 signal → dispatch < 60s p95, queue never backs up > 500
  · heartbeat-concurrency.js
      target: 300 tenants × 14 agents × 2 heartbeats/day (baseline from problem statement)
      SLO: run completion < 30s p95, no DLQ entries
  · approval-queue-page-load.js
      target: 500 concurrent founders loading queue
      SLO: < 800ms p95
  · ws-connection-scale.js
      target: 2,000 concurrent WS connections across 3 api instances
      SLO: fan-out latency < 500ms p95, zero dropped events
  · critique-throughput.js
      target: 10,000 critiques/hr sustained
      SLO: critique completion < 15s p95
  · experiment-evaluation-batch.js
      target: 500 experiments × 10k observations each in a single run
      SLO: evaluation completes in < 10min
```

### 18.10 Chaos tests (every HA claim has one)

Tool: Chaos Mesh (k8s) or Toxiproxy (local). Run weekly in staging; monthly drill in a prod replica.

```text
chaos/
  · redis-primary-failover.spec
      inject: kill Redis primary
      assert: Sentinel promotes replica within 10s; no job lost; WS degrades gracefully; scheduler leader recovers
  · postgres-failover.spec
      inject: promote read replica to primary
      assert: api + workers reconnect within 30s; no RLS bypass during reconnect
  · smartermcp-timeout-spike.spec
      inject: 50% of SmarterMCP calls timeout
      assert: agent runs retry read-only tools, fail fast on writes; no duplicate external sends; circuit breaker opens
  · outbox-relay-leader-kill.spec
      inject: kill relay leader
      assert: follower takes over in < 10s; no duplicate publishes; no gaps on WS clients
  · single-tenant-signal-flood.spec
      inject: one tenant sends 10k webhooks in 60s
      assert: per-tenant rate limit holds; other tenants unaffected; backpressure demotion kicks in
  · worker-pool-decimation.spec
      inject: kill 80% of heartbeat workers
      assert: remaining workers drain queue within 10 min; no jobs lost; UI shows delayed-processing banner
  · pubsub-full-outage.spec
      inject: block all Pub/Sub traffic
      assert: UI polling fallback active < 10s; workers continue via outbox; banner shown; full recovery when restored
  · clock-skew-between-instances.spec
      inject: 30s skew between api instances
      assert: scheduler leader election still deterministic; no duplicate job firing
```

### 18.11 Data quality & offline evals

These are not unit tests — they are scheduled batch jobs that track product quality over time. Failures page the product owner, not oncall.

```text
evals/daily/
  · confidence-calibration.job
      compare predicted confidence buckets (0.6-0.7, 0.7-0.8, 0.8-0.9, ≥0.9) against observed approval outcomes
      alert: if bucket's observed approval rate deviates > 10 percentage points from predicted midpoint for > 3 days

  · experiment-false-discovery.job
      replay last 30 days of experiments against synthetic null hypothesis
      alert: if false positive rate > 5%

  · learning-decay-integrity.job
      assert every active learning has last_validated_at within TTL window
      alert: on any leaked expiration

  · claim-verification-freshness.job
      count claims past valid_until still marked verified
      alert: on > 0

  · cost-per-approved-action.job
      compute per-tenant cost/approved-action, flag outliers
      alert: if any tenant's cost/action is > 3× cohort median

evals/weekly/
  · prompt-regression.job
      run golden-prompt set against current model + last 4 weeks of snapshots
      diff outputs, flag semantic regressions via embedding similarity

  · cross-tenant-leak-probe.job
      red-team script attempts known bypass patterns
      zero tolerance; any success pages security lead

  · playbook-diff-quality.job
      sample 20 founder-approved playbook diffs, score with rubric LLM
      track quality trend; alert on sustained decline
```

### 18.12 CI gates

```text
every PR (blocking, < 10 min total):
  · unit suite
  · contract suite
  · RLS / tenant-isolation suite
  · smoke integration suite (subset, ~20 tests covering critical seams)
  · lint + typecheck + schema validation
  · redis-key-prefix linter
  · migration dry-run against shadow DB snapshot

pre-merge-to-main (blocking, < 25 min):
  · full integration suite
  · security suite
  · e2e full-loop test

nightly (non-blocking but tracked, pages on repeated failure):
  · load suite
  · SmarterMCP contract test against real staging gateway
  · offline eval suite

weekly (blocking weekly release):
  · chaos suite
  · cross-tenant red-team probe
  · playbook diff quality eval
```

### 18.13 Test environments and data strategy

**Synthetic tenants.** We maintain 5 named synthetic tenants (`testco-inbound-heavy`, `testco-outbound-heavy`, `testco-plg`, `testco-abm`, `testco-lifecycle`) with deterministic fixtures: CRM data, 90 days of activity, known motion-score outcomes, seeded claims library, seeded experiments in each stage. Any time a bug is found in prod, it gets reproduced as a fixture on one of these tenants.

**Fixture loading.** Fixtures live in `fixtures/<tenant-slug>/` as JSON and are loaded via a single `seedTenant(slug)` helper. Load time target: < 5s for the full tenant.

**LLM stubs.** Producer LLMs are replaced in tests with `RecordingLLM` — on first run against staging, it records real model outputs to a JSON fixture; subsequent runs replay. Refreshing a fixture requires a PR so drift is visible.

**SmarterMCP fake.** An in-process fake that implements the real gateway's contract plus hooks to simulate timeouts, rate limits, DLP blocks, and partial failures. Nightly contract test compares fake behavior against real staging gateway.

**Time control.** A shared `TestClock` singleton is injected in all tests. `clock.advance('7 days')` works across workers. Real `Date.now()` use is forbidden by a lint rule.

**Isolation.** Each test gets its own tenant (UUID-namespaced) via a `withTenant()` helper that seeds and cleans up. No shared-state tests.

### 18.14 What we deliberately do *not* test in CI

Being explicit about the negative space:

- **Raw LLM quality.** That's the offline eval suite (§18.11), not CI. CI would be non-deterministic and slow.
- **Third-party SaaS correctness.** We test our contract with them, not their internals.
- **UI pixel-perfect rendering.** Visual regression is valuable but lives outside the merge gate.
- **Absolute cost numbers.** We assert cost-delta regressions, not absolute dollar amounts that fluctuate with provider pricing.

Every one of these has a corresponding monitor or manual process. They are not tested in CI because CI is for invariants, not for measurement.

---

## Appendix A — Module ownership map

| Module | Ownership | Deploy unit |
|---|---|---|
| Paperclip fork (hardened) | platform | `paperclip-core` + `api` |
| BullMQ scheduler | platform | `scheduler` |
| Outbox relay (Pub/Sub fan-out) | platform | `outbox-relay` |
| WebSocket / SSE gateway | platform | `ws-gateway` (co-located with `api` in v1) |
| SmarterMCP | vendored, configured | separate service |
| Motion Engine | domain | library in `api` + `worker-heartbeat` |
| Signal Router | domain | `worker-signal-router` |
| Confidence Scorer | domain | library + `worker-critique` |
| Experiment Manager | domain | library in `api` + nightly `worker-attribution` |
| Learning Director | domain | `worker-learning` |
| Warmth Builder | domain | `worker-warmth` |
| GEO Monitor | domain | `worker-geo` |
| Attribution | domain | `worker-attribution` |
| Lifecycle Engine | domain | library in `api` |
| Skills & Memory Resolvers | domain | library in `worker-heartbeat` |
| Founder UI | product | `api` (Next.js) |
| Onboarding | product | `api` |
| Founder digest | product | `worker-heartbeat` (scheduled) |

---

## Appendix B — Minimal sequence: from signal to action

End-to-end trace of a P2 inbound action triggered by a competitor pricing change.

```text
t+0s    Webhook arrives at /api/webhooks/watch → signal_events insert.
t+0.1s  Signal Router picks up from Redis stream.
        Stage 1 rule match: kind=competitor.pricing_change.
        Urgency: P1. Half-life: 2h. Target: intel_director.
t+0.5s  signals row created. paperclip.wakeup(intel_director) queued.
t+0.8s  Heartbeat worker consumes; Paperclip run created.
t+1.0s  growthos_native adapter: skills resolved (intel_director@active),
        memory resolved (icp_snapshot, messaging_matrix, recent_signals),
        SmarterMCP session opened (tools: research.web, analytics.read).
t+1-12s LLM synthesis: competitor delta + content opportunity hypothesis.
t+12s   Fast confidence scoring: 0.78. Risk tier: P0 (internal brief).
t+12s   Intel brief written as issue document. Handoff emitted:
        content_opportunity.v1 → inbound_content_strategist.
t+12.5s New Paperclip issue created, assigneeAgentId=inbound_strategist.
t+13s   Strategist heartbeat consumes; adapter loads skills + claims library.
t+13-25s LLM generates content_brief (P0, no approval) + proposes blog_draft (P2).
t+25s   Fast confidence: 0.71. critique enqueued.
t+28s   Async critique: composite 0.76. DLP scan: claims all verified. Passes.
t+28s   executionPolicy advances to approval stage.
        Founder gets digest notification + approval queue entry.
t+?     Founder reviews, edits 12% of the draft, approves.
t+0     approval_feedback row: action=edited_then_approved, edit_distance=0.12.
t+0.5s  dispatch queued: content.cms.publish (CMS tool via SmarterMCP).
t+2s    Published. confirmed event. attribution touchpoint created.
t+1d    Analytics: 180 sessions, 4 signups from this piece.
        performance.observed event → Learning Director ingests.
t+7d    Aggregated: this brief's comparison-format outperformed last week's
        thought-leadership format by 2.3× signups/view.
t+7d    Candidate learning: "comparison format > thought-leadership for this ICP".
t+8d    Founder approves learning in weekly review.
t+8d    playbook_versions bumped for skills/inbound/content_strategist.md.
        Next content briefs default to comparison-first structure.
```

That is the loop. Every other piece of the architecture exists to make that loop **safe, cheap, fast, and honest**.
