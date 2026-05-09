# GrowthOS — System Design Document

**Version:** 4.0  
**Status:** Canonical reference  
**Audience:** Staff engineers, platform architects, AI systems engineers

---

## 1. Purpose and Scope

GrowthOS is a **motion-first startup operating system** for GTM, revenue, and growth execution. It compresses early-stage GTM work that would otherwise require 6–10 hires — covering acquisition, activation, conversion, retention, and expansion — into a single governed platform with human oversight where risk is high.

This document describes:

- System topology and component boundaries
- Data architecture and stores
- Agent roster, harness design, and lifecycle
- Core domain subsystems
- Event flow and outbox design
- API surface and realtime delivery
- Security, policy, and trust model
- Performance targets and scalability approach

---

## 2. Design Principles


| #   | Principle                                                  | Implication                                                                                          |
| --- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1   | Paperclip is the harness — extend, don't reinvent          | Companies, agents, issues, routines, approvals, heartbeat-runs are primitives we use, not rebuild    |
| 2   | Domain layer is the moat                                   | Motion scoring, signal routing, learning, confidence, warmth, GEO, experiments, attribution are ours |
| 3   | SmarterMCP is the tool gateway                             | No agent calls external SaaS directly; every tool call exits through the governed gateway            |
| 4   | Automate repeatable GTM work, not strategic accountability | Human approval required for all P2–P4 actions (public, commercial, sensitive)                        |
| 5   | One canonical owner per domain                             | Avoid split-brain state; all state changes emit versioned events                                     |
| 6   | Durable-first execution                                    | Workflows checkpoint at every node; idempotency key on every external action                         |
| 7   | Filesystem is the memory spine                             | Skills, playbooks, claims — all files in per-tenant Gitea repos; Postgres indexes them               |
| 8   | 100% self-hostable                                         | No managed-service lock-in in the critical path; runs on K3s or Docker Compose                       |


---

## 3. System Topology

### 3.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Founder Surfaces                             │
│   Next.js 15 web app (App Router + RSC)   ·   Email   ·  Webhooks  │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ HTTPS + Zitadel OIDC session
                           │
┌──────────────────────────▼──────────────────────────────────────────┐
│                   GrowthOS API Gateway                              │
│   Hono + @hono/zod-openapi   ·   AuthN (Zitadel)                    │
│   Tenant resolve   ·   Rate limit   ·   Lago entitlement check      │
│   Idempotency enforcement   ·   WebSocket / SSE upgrade             │
└────────┬────────────────────────────────────┬────────────────────────┘
         │                                    │
┌────────▼─────────────┐          ┌───────────▼─────────────────────────┐
│   Paperclip Core     │          │     GrowthOS Domain Plane           │
│   (forked)           │◀────────▶│  (new services)                     │
│                      │  events  │                                     │
│  · agents            │          │  · Motion Engine                    │
│  · issues / docs     │          │  · Signal Router (Rust)             │
│  · routines          │          │  · Confidence Scorer (Rust)         │
│  · approvals         │          │  · Experiment Manager               │
│  · heartbeat_runs    │          │  · Learning Director                │
│  · execution policy  │          │  · Attribution Engine (Rust)        │
│  · org / audit       │          │  · Warmth Builder                   │
│  · budget tracking   │          │  · GEO Monitor                      │
└────────┬─────────────┘          │  · Lifecycle Engine                 │
         │                        │  · Skills Resolver                  │
         │                        │  · Memory Resolver                  │
         │                        └───────────────┬─────────────────────┘
         │                                        │
         │         ┌──────────────────────────────┘
         │         │
┌────────▼─────────▼──────────────────────────────────────────────────┐
│                   NATS JetStream                                     │
│   Persistent streams   ·   Consumer groups   ·   KV store           │
│   Subject: t.{tenant}.{domain}.{event}                              │
│   ws-gateway (WS/SSE fan-out)   ·   Learning replay                 │
│   Attribution batch   ·   Signal dispatch                           │
└────────┬────────────────────────────────────────────────────────────┘
         │
┌────────▼──────────────────────────────────────────────────────────────┐
│                        Data Layer                                      │
│   Postgres 16 + pgvector (OLTP, RLS, outbox)                          │
│   ClickHouse OSS (time-series, attribution, analytics drill-downs)     │
│   Qdrant (dense vectors: learnings, claims, memory at scale)           │
│   Meilisearch (FTS + facets: signals, approvals, run logs)             │
│   Valkey / Redis 7 (cache only — NOT queues, NOT pub/sub)             │
│   MinIO (objects: evidence bundles, exports, attachments)              │
│   Gitea (per-tenant agent filesystem: skills, playbooks, claims, docs) │
└────────────────────────────────────────────────────────────────────────┘
                      │
┌─────────────────────▼──────────────────────────────────────────────┐
│                SmarterMCP Gateway (separate service)               │
│   Tenant isolation   ·   Tool entitlements   ·   DLP (Presidio)    │
│   proxy_search / proxy_filter / proxy_explore                      │
│   Response cache   ·   Per-tenant quotas   ·   Immutable audit     │
└──────────────────────────────────┬─────────────────────────────────┘
                                   │ MCP / HTTPS
                                   │
┌──────────────────────────────────▼─────────────────────────────────┐
│                   Upstream MCP Servers / SaaS                       │
│  CRM (HubSpot/Salesforce)   ·   GA4 / Mixpanel / Segment           │
│  LinkedIn / X / Slack / Reddit   ·   Google / Perplexity / Exa     │
│  Customer.io / Loops / Resend   ·   Apollo / Clearbit               │
│  Search APIs / GEO probes                                           │
└────────────────────────────────────────────────────────────────────┘
```

### 3.2 Process Inventory


| Process                | Purpose                                                 | Language              | Scaling model                 |
| ---------------------- | ------------------------------------------------------- | --------------------- | ----------------------------- |
| `api`                  | HTTP API + RSC + WebSocket gateway                      | TypeScript / Node 22  | Stateless horizontal          |
| `paperclip-core`       | Agent registry, issues, approvals, audit                | TypeScript / Node 22  | Stateless horizontal          |
| `worker-heartbeat`     | Executes agent heartbeat runs                           | TypeScript            | Horizontal pool               |
| `worker-signal-router` | Classifies, scores, and dispatches real-time signals    | Rust                  | Horizontal, sub-50ms P95      |
| `worker-critique`      | Second-pass LLM self-critique + confidence scoring      | Rust (fast-path) + TS | Horizontal, GPU-free          |
| `worker-learning`      | Learning Director synthesis pipeline                    | TypeScript            | Low concurrency, high memory  |
| `worker-attribution`   | Nightly / windowed multi-touch rollups                  | Rust                  | Batch                         |
| `worker-warmth`        | LinkedIn touch scheduling + content engagement tracker  | TypeScript            | Horizontal                    |
| `worker-geo`           | Periodic AI-search citation probes                      | TypeScript            | Horizontal, rate-limited      |
| `outbox-publisher`     | Postgres NOTIFY → NATS JetStream bridge, leader-elected | Rust                  | 1 leader (NATS KV), N standby |
| `smartermcp-gateway`   | Tool gateway (SmarterMCP)                               | Per vendor            | Separate deployment           |
| Restate server         | Durable workflow execution                              | OSS binary            | Clustered                     |


**Design stance:** one Postgres DB, one NATS cluster, no internal gRPC mesh until a specific service earns it with a measurable scale or blast-radius problem.

---

## 4. Data Architecture

### 4.1 Store Responsibilities


| Store                      | Workload                                                          | Key tables / collections                                                                                               |
| -------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Postgres 16 + pgvector** | OLTP: all transactional state, event outbox, small vector indexes | `tenants`, `motion_stack`, `experiments`, `gtm_learnings`, `approval_feedback`, `playbook_versions`, `event_outbox`    |
| **ClickHouse**             | Time-series, attribution, analytics drill-downs                   | `activity_log`, `cost_events`, `attribution_touchpoints`, `experiment_observations`, `geo_citations`, heartbeat events |
| **Qdrant**                 | Dense vector retrieval at scale                                   | Learnings, claims, evidence bundles, memory chunks                                                                     |
| **Meilisearch**            | Full-text + faceted search                                        | Approval queue, signals, run logs, skill manifests                                                                     |
| **Valkey / Redis 7**       | Cache only                                                        | Enrichment cache, skill manifest cache, session tokens                                                                 |
| **MinIO**                  | Object storage                                                    | Evidence bundles, exports, attachments, large content artifacts                                                        |
| **Gitea**                  | Per-tenant agent filesystem                                       | Skills, playbook versions, claims library, brand voice, evidence files                                                 |


### 4.2 Core Schema (Postgres `growthos` schema)

```sql
-- Immutable event outbox (transactional, then relayed to NATS)
CREATE TABLE event_outbox (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  event_type  TEXT NOT NULL,  -- e.g. output.approval.requested
  payload     JSONB NOT NULL,
  published_at TIMESTAMPTZ,   -- set ONLY after NATS ack
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Active motion stack per tenant
CREATE TABLE motion_stack (
  tenant_id   UUID NOT NULL,
  motion      TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('primary','secondary','observe','deactivated')),
  score       NUMERIC(4,2) NOT NULL,
  rationale   TEXT[],
  scored_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, motion)
);

-- Typed learnings
CREATE TABLE gtm_learnings (
  id              UUID PRIMARY KEY,
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
  learned_from    TEXT[] NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL CHECK (status IN ('candidate','active','expired','rejected','superseded')),
  created_at      TIMESTAMPTZ NOT NULL,
  last_validated_at TIMESTAMPTZ,
  supersedes_id   UUID
);

-- Approval and edit telemetry (primary learning signal)
CREATE TABLE approval_feedback (
  id              UUID PRIMARY KEY,
  tenant_id       UUID NOT NULL,
  output_id       UUID NOT NULL,
  output_type     TEXT NOT NULL,
  action          TEXT NOT NULL CHECK (action IN ('approved','edited_then_approved','rejected')),
  edit_distance   NUMERIC(6,4),
  rubric_failures TEXT[] NOT NULL DEFAULT '{}',
  reviewer_note   TEXT,
  created_at      TIMESTAMPTZ NOT NULL
);

-- Experiments
CREATE TABLE experiments (
  id              UUID PRIMARY KEY,
  tenant_id       UUID NOT NULL,
  motion          TEXT NOT NULL,
  experiment_type TEXT NOT NULL,
  unit_type       TEXT NOT NULL,
  variant_a       JSONB NOT NULL,
  variant_b       JSONB NOT NULL,
  metric_name     TEXT NOT NULL,
  min_sample_size INT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('running','concluded','abandoned','promoted')),
  winner          TEXT CHECK (winner IN ('a','b','inconclusive')),
  confidence      NUMERIC(4,3),
  started_at      TIMESTAMPTZ NOT NULL,
  ended_at        TIMESTAMPTZ
);

-- Versioned playbook artifacts (immutable history)
CREATE TABLE playbook_versions (
  id           UUID PRIMARY KEY,
  tenant_id    UUID NOT NULL,
  motion       TEXT NOT NULL,
  artifact_type TEXT NOT NULL CHECK (artifact_type IN ('skills','policy','workflow','messaging')),
  content      JSONB NOT NULL,
  version      INT NOT NULL,
  change_reason TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL
);
```

All tenant-scoped tables carry an `app_role` RLS policy enforcing `tenant_id = current_setting('app.tenant_id')::uuid`. No cross-tenant query is possible at the application layer.

### 4.3 Canonical Sources of Truth


| Domain                                   | System of record                                            |
| ---------------------------------------- | ----------------------------------------------------------- |
| CRM entities, deals, lifecycle ownership | CRM (HubSpot/Salesforce)                                    |
| Domain events (outbox → NATS)            | `event_outbox` → NATS JetStream                             |
| Agent activity, heartbeat traces         | Paperclip `heartbeat_runs` + ClickHouse `activity_log`      |
| Experiment state                         | `experiments` table                                         |
| Structured learnings and playbook        | `gtm_learnings` + `playbook_versions` + Gitea (skill files) |
| Tool call audit                          | SmarterMCP immutable audit log                              |
| Billing / plan entitlements              | Lago (usage) + Stripe (card rail)                           |
| Founder secrets, CRM API keys            | OpenBao per-tenant KMS-wrapped                              |


---

## 5. Event Flow and Outbox

### 5.1 Transactional Outbox

Every domain mutation that produces a side effect writes an `event_outbox` row **inside the same Postgres transaction**. No outbox row = no event published. `published_at` is set only after NATS JetStream acknowledges the message.

```
Postgres domain mutation (TX)
  └─ event_outbox INSERT

Postgres NOTIFY 'outbox.ready'
  └─ outbox-publisher (Rust, leader-elected via NATS KV)
        · SELECT WHERE published_at IS NULL LIMIT 100 FOR UPDATE SKIP LOCKED
        · Publish to NATS JetStream with msgID = outbox row ID (NATS dedup)
        · On NATS ACK: UPDATE SET published_at = now()

NATS JetStream subjects (t.{tenant}.{domain}.{event})
  ├─ ws-gateway       → founder UI (WS/SSE) + gap backfill via JetStream replay
  ├─ worker-learning  → consumer group, per-tenant committed offsets
  ├─ worker-attribution → nightly batch from stream offset
  └─ external webhook delivery (future)
```

### 5.2 Event Taxonomy

```
motion.stack.selected          agent.task.created
agent.output.generated         output.confidence.scored
output.policy.checked          output.approval.requested
output.approved                output.rejected
action.dispatched              action.confirmed
performance.observed           experiment.started
experiment.concluded           learning.candidate.created
learning.activated             playbook.updated
risk.blocked                   lifecycle.stage.changed
```

### 5.3 Realtime Delivery to Founder UI

NATS JetStream subjects fan into the `ws-gateway` (co-located with API in v1, split at scale). The gateway maintains per-connection state and delivers to WebSocket or SSE clients. Clients can replay from a JetStream sequence offset on reconnect — no polling required.

---

## 6. Agent Architecture

### 6.1 Harness Integration (Paperclip)

Every GrowthOS agent is a Paperclip `agent` record with `adapterType = "growthos_native"`. The custom adapter runs a ReAct loop via Anthropic SDK (through LiteLLM proxy) and provides:

- **JIT context assembly:** FOUNDER.md loaded at start; skill manifests lazy-loaded; full skill body fetched only when agent selects the skill
- **Confidence scoring:** every output scored before persistence; low-confidence outputs never reach P2+ queue
- **Budget enforcement:** per-run LiteLLM session budget + 90% safety margin in the adapter
- **MCP tool set:** recomputed per heartbeat from `motion_stack × skill_manifest × current_task` — agent never sees tools it cannot use

### 6.2 Agent Roster

#### Always-Present


| Agent                  | Mission                                                           | Triggers                        |
| ---------------------- | ----------------------------------------------------------------- | ------------------------------- |
| **Intel Director**     | Maintain current picture of ICP, competitors, pain signals        | Daily + major market signals    |
| **Learning Director**  | Turn outcomes, edits, experiments, failures into playbook updates | Action-complete events + weekly |
| **Reporting Director** | Weekly operating review: motion health, bottlenecks, next actions | Weekly                          |


#### Motion-Specific Pool (activated from motion stack)


| Agent                          | Mission                                                   | Active when                  |
| ------------------------------ | --------------------------------------------------------- | ---------------------------- |
| **Inbound Content Strategist** | Content assets mapped to motion goals and proof points    | `inbound` active             |
| **Community Operator**         | Monitor communities, draft replies, surface opportunities | `community` active           |
| **Warm Outbound Researcher**   | Research targets, prepare warm outbound paths             | `outbound` active            |
| **Lifecycle Operator**         | Activation, onboarding, retention, light expansion nudges | `lifecycle_expansion` active |
| **Partner Scout**              | Identify partnership and co-marketing fits                | `partners` active            |


#### V2 Expansion Pool

ABM Planner · Customer Expansion Analyst · GEO Monitor · Launch Orchestrator · Revenue Leak Investigator · Founder Narrative Assistant

### 6.3 What Are NOT Agents

The following are backend services — deterministic code, not LLM agents:

- Scheduler · Signal ingestion connectors · Experiment evaluator  
- Attribution aggregator · Risk / policy engine · Idempotency manager  
- Lifecycle stage calculator · Approval routing engine · Billing enforcement

### 6.4 Durable Execution (Restate)

Key Restate workflows:


| Workflow             | Purpose                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `TenantProvisioning` | Onboards a new tenant: creates Gitea repo, seeds motion scoring, provisions Zitadel org          |
| `HeartbeatRun`       | Wraps every agent heartbeat; checkpoints at each node boundary; retries with exponential backoff |
| `LearningPipeline`   | Ingests outcomes → creates candidate learning → durable promise blocks for human approval gate   |


Each workflow node boundary is a Restate checkpoint. On failure the workflow resumes from the last checkpoint — no duplicated external actions.

---

## 7. Domain Subsystems

### 7.1 Motion Engine

Scores eight motions (Inbound · Community · Outbound · PLG · ABM · Partners · Paid · Lifecycle/Expansion) against fifteen dimensions including ACV, product complexity, founder content capacity, and signal richness. Outputs an ordered `motion_stack` with `primary`, `secondary`, and `deactivated` buckets.

**Re-score triggers:** onboarding, 30 days, quarterly, pricing changes, ICP shifts, sustained underperformance, founder strategic overrides.

**Activation rule:** a motion activates only if score > threshold AND required data sources are connected. High-risk motions (paid, outbound) require explicit founder confirmation.

### 7.2 Signal Router

Always-on real-time event pipeline implemented in Rust.

```
Ingest (NATS / webhook) → Classify (rule engine) → LLM enrichment (ambiguous signals only)
  → Urgency score → Dispatch to heartbeat queue or approval queue
```

Two-stage classification: rule-based (fast, cheap) handles ~80% of signals; LLM via LiteLLM handles ambiguous cases. Consumer group ensures exactly-once processing per tenant.

### 7.3 Confidence Scorer

Every agent output passes through the confidence scorer before persistence. Score combines:


| Dimension                                   | Weight    |
| ------------------------------------------- | --------- |
| Structural correctness (schema valid)       | hard gate |
| Policy compliance (claims verified, no PII) | hard gate |
| Brand alignment                             | 20%       |
| ICP / target fit                            | 20%       |
| Specificity vs. generic boilerplate         | 15%       |
| Recency of supporting evidence              | 15%       |
| Novelty vs. known-losing patterns           | 15%       |
| Factuality / proof availability             | 15%       |


Score gates:

- `< 0.5` → discard; do not queue
- `0.5–0.75` → queue for human review with full evidence
- `> 0.75` → eligible for auto-approve if policy tier allows (P0/P1 only)

### 7.4 Learning Director

Turn performance signals into controlled playbook changes.

```
Learning sources:
  experiment outcomes · approval edits · lifecycle conversions
  content performance · outbound reply rates · founder overrides
  negative incidents / policy blocks

Pipeline:
  1. Ingest performance events from NATS stream (90-day replay window via JetStream offsets)
  2. Cluster events into candidate patterns (ClickHouse aggregation)
  3. Require min evidence count + baseline comparison before promoting a candidate
  4. Gate promotions above confidence threshold behind founder approval (Paperclip `approvals`)
  5. Apply approved learnings: update skill files in Gitea, update `playbook_versions`, bump confidence thresholds

Do-not-learn filters:
  - single-event learnings
  - anomalous time windows (launches, incidents)
  - learnings touching compliance/legal rules
  - learnings proposed by a failed experiment

TTL: every learning has `ttl_days` (default 90). Learning Director revalidates active learnings on cadence; unvalidated learnings expire automatically.
```

### 7.5 Experiment Framework

GrowthBook (self-hosted) provides Bayesian A/B statistics. GrowthOS wraps it with:

- Variant generation from the agent's current skill set
- `experiments` table for state management (running → concluded → promoted/abandoned)
- Automatic sample-size checking before conclusion
- Winning variant automatically proposed to Learning Director as a candidate learning

### 7.6 Attribution Engine

Multi-touch attribution aggregated nightly from ClickHouse `attribution_touchpoints`. Default model: linear attribution. Outputs feed back into motion scoring and the Weekly Operating Review. Reports carry explicit confidence caveats — GrowthOS does not pretend attribution is solved.

### 7.7 Warmth Builder

Tracks LinkedIn engagement, content interactions, and community signals to build a warmth gradient per target account. Outbound runs (Warm Outbound Researcher) read this gradient before generating personalization context. Cold outreach is blocked by policy; warm ≥ threshold is required.

### 7.8 GEO Monitor

Periodic probes to AI-answer engines (ChatGPT, Perplexity, Gemini) to track whether GrowthOS customer content is cited. Feeds the Inbound Content Strategist's GEO optimization loop. Results stored in ClickHouse `geo_citations`.

---

## 8. API Design

### 8.1 API Gateway (Hono)

All API routes:

- AuthN: Zitadel JWT → resolved to `tenant_id` via `companies` table
- Idempotency: `Idempotency-Key` header required on all POST/PUT/PATCH (24h window, DB-backed)
- Response contract: ≤200ms for mutations (hand off to NATS/Restate, stream updates via WS)

Key endpoints:


| Path                      | Method | Purpose                                                    |
| ------------------------- | ------ | ---------------------------------------------------------- |
| `/v1/outputs/:id/approve` | POST   | Approve an output; triggers dispatch workflow              |
| `/v1/outputs/:id/reject`  | POST   | Reject; feeds approval_feedback learning signal            |
| `/v1/signals/webhook`     | POST   | Ingest external signal (webhook from CRM, analytics, etc.) |
| `/v1/tenants`             | POST   | Provision new tenant (triggers Restate TenantProvisioning) |
| `/v1/motions/score`       | POST   | Trigger manual motion re-score                             |
| `/v1/experiments/:id`     | GET    | Experiment details + Bayesian posterior                    |
| `/v1/weekly-review`       | GET    | Latest Weekly Operating Review                             |


### 8.2 Internal Routing (tRPC v11)

Intra-monorepo calls between `api`, domain services, and workers use tRPC v11 with Zod-inferred types. No REST over the wire for internal paths.

---

## 9. Policy and Trust Model

### 9.1 Action Tiers


| Tier          | Example                                             | Approval required  | Default behavior                                                    |
| ------------- | --------------------------------------------------- | ------------------ | ------------------------------------------------------------------- |
| P0 Internal   | Summary brief, draft for internal review            | None               | Auto-persist                                                        |
| P1 Moderate   | Blog draft, newsletter draft, CRM note              | Optional queue     | Auto-approve if confidence > 0.75                                   |
| P2 Public     | Community reply, social post, website publish       | Required initially | Queue; founder approves; auto-approve unlockable after track record |
| P3 Commercial | Outbound email, partner outreach, expansion message | Always required    | Queue; never auto                                                   |
| P4 Sensitive  | Pricing claims, legal wording, investor materials   | Human ownership    | AI assist only; no dispatch path                                    |


### 9.2 External Action State Machine

```
drafted
  → confidence_scored
  → policy_checked
  → approval_required
      → approved → dispatched → confirmed → measured
      → rejected → revised
      → expired (24h timeout → archived with notification)
```

### 9.3 Key Guardrails

- Claims library with verification status — every factual claim must be traceable to evidence in Gitea
- DLP via Microsoft Presidio in SmarterMCP filter chain — scans for PII and unverified claims before dispatch
- Community norms per platform — hard-coded per-channel posting policies
- Suppression lists and consent enforcement
- Per-tenant rate limits enforced at SmarterMCP — runaway agent cannot exhaust upstream credits
- Anomaly alerts for action spikes (>3× 7-day rolling average triggers hold + notification)
- Do-not-learn filters prevent policy and compliance rules from being overwritten by learning

---

## 10. Realtime Architecture

### 10.1 WebSocket Fan-out

```
NATS JetStream (t.{tenant}.*)
  └─ ws-gateway (Node / Hono, co-located with api in v1)
       ·  Per-connection subscription map
       ·  Gap backfill: client sends last known JetStream sequence on connect
       ·  Delivers: approval queue updates, heartbeat run events, experiment posteriors
```

No polling. No Supabase Realtime dependency. The NATS subject hierarchy `t.{tenant}.{domain}.{event}` enforces tenant isolation structurally — the ws-gateway subscribes only to the authenticated tenant's subtree.

---

## 11. Observability


| Signal                      | Tool                                          |
| --------------------------- | --------------------------------------------- |
| Distributed traces (OTel)   | SigNoz (or Grafana Tempo)                     |
| Metrics                     | SigNoz / Prometheus + Grafana Mimir           |
| Logs                        | Loki                                          |
| LLM traces + eval runs      | Langfuse (self-hosted, AGPL)                  |
| Offline LLM evals           | Promptfoo (OSS MIT) in CI                     |
| Error tracking              | GlitchTip (OSS Sentry fork)                   |
| Feature flags + experiments | GrowthBook (self-hosted)                      |
| Cost attribution per tenant | ClickHouse `cost_events` + Langfuse run costs |


Every Paperclip heartbeat run carries a `X-Paperclip-Run-Id` header propagated through all downstream calls. SmarterMCP tool call logs are joinable on this header.

---

## 12. Security Architecture


| Concern          | Mechanism                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| AuthN            | Zitadel OIDC; JWT validated at API gateway; no session token stored in agent memory                             |
| AuthZ            | Postgres RLS `app_role` enforces `tenant_id` on every table; no raw SQL without RLS active                      |
| Secrets          | OpenBao per-tenant KMS-wrapped; dynamic DB credentials via Vault PKI; never stored in env vars at rest          |
| Tool isolation   | SmarterMCP enforces tool entitlements per tenant per motion stack; no agent escapes its sandbox                 |
| Agent sandboxes  | Daytona / E2B per-run isolated workspace; bash, browser, code exec — no persistent cross-run state              |
| DLP              | Presidio scans all outbound content for PII and unverified claims before dispatch                               |
| Tenant isolation | `natsSubject(tenant_id, ...)` helper enforces prefix on every NATS publish; consumer groups prefixed per tenant |
| Audit            | SmarterMCP immutable tool-call log + Paperclip `heartbeat_runs` + `event_outbox` → full action provenance       |


---

## 13. Deployment and Infra

### 13.1 Local Development

`docker compose -f compose.dev.yaml up` brings up the full local stack:
Postgres 16 · ClickHouse · Qdrant · Meilisearch · Valkey · MinIO · Gitea · NATS JetStream · Restate · LiteLLM · Langfuse · OTel collector · all app services

`make dev` — start dev stack  
`make db-migrate` — run Drizzle migrations  
`make seed` — provision dev tenant via Restate  
`make smoke` — Phase 0 exit-criterion smoke test

### 13.2 Production Topology

**Phase 1 (≤50 tenants):** Coolify on a single VPS; docker-compose-style. Fastest path to paying customers.

**Phase 2 (50–1000 tenants):** K3s + Argo CD + Argo Rollouts. Helm charts per service. Argo Rollouts for canary deploys on workers.

**IaC:** Pulumi (TypeScript) or OpenTofu.  
**CI/CD:** GitHub Actions (primary) or Woodpecker CI (Gitea-native, fully OSS).

---

## 14. Performance Targets


| Metric                          | Target         | Key path                                                         |
| ------------------------------- | -------------- | ---------------------------------------------------------------- |
| Signal → dispatch P95           | < 60s          | Rust Signal Router + NATS fan-out + Restate dispatch             |
| Approval queue page load P95    | < 300ms        | RSC streaming + TanStack Virtual + ClickHouse aggregates         |
| Outbox → WS delivered P95       | < 200ms        | NATS ack → ws-gateway push, single broker hop                    |
| Heartbeat cold start            | < 2s           | Skill manifest + memory resolver cached in Valkey; full body JIT |
| Learning Director 90-day replay | < 5 min/tenant | ClickHouse + JetStream replay; Postgres never full-scanned       |
| API mutation response           | ≤ 200ms        | Hand off to NATS / Restate; stream result via WS                 |


---

## 15. Key Design Invariants

1. **All NATS subjects via `natsSubject()` helper** — tenant isolation enforced structurally, not by convention.
2. **All API mutations return ≤200ms** — hand off to NATS/Restate; stream via WS.
3. `**Idempotency-Key` required on all POST/PUT/PATCH** — 24h window DB-backed dedup.
4. **Transactional outbox** — every domain mutation writes outbox row in same TX before returning; no fire-and-forget.
5. **RLS on every tenant-scoped table** — `app_role` enforces it; no bypass path in application code.
6. **Confidence scoring before persistence** — every output scored; rubric_failures stored; low-confidence discarded.
7. **Budget enforcement** — per-run budget via LiteLLM session + 90% safety margin in adapter; hard ceiling in SmarterMCP.
8. **One canonical owner per domain** — no split-brain; other systems hold indexed/derived copies only.
9. **Versioned playbook artifacts** — every playbook change is a new row in `playbook_versions`; no silent mutations.
10. **Learning TTL + revalidation** — every learning expires unless revalidated; fossilized playbooks are prevented structurally.

---

## 16. Open Decisions (Phase 1 blockers)


| Decision                  | Options                                                | Recommendation                                                                  |
| ------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Durable execution runtime | Restate vs Temporal                                    | **Restate** for ≤5 engineers (simpler, TS-native); revisit at scale             |
| v1 deploy target          | Coolify vs K3s day 1                                   | **Coolify** for first 50 tenants; K3s when platform engineer joins              |
| Vector store              | pgvector HNSW first vs Qdrant now                      | **pgvector** under ~1M vectors/tenant; Qdrant migration plan on file            |
| Effect-TS adoption        | Optional vs mandatory                                  | **Optional** for ≤3 engineers; adopt in domain services when team grows         |
| Rust at Phase 1           | Yes vs wait                                            | **Wait** — Phase 1 can be TS-only; introduce Rust when Signal Router P95 drifts |
| Gitea topology            | Per-tenant instance vs shared Gitea + per-tenant repos | **Shared Gitea, per-tenant repos** — pragmatic, access-controlled               |


---

## 17. Competitive Moat Summary

The moat is not agent orchestration. The moat is:

> **A founder-specific, evidence-backed startup operating playbook that compounds across motions and lifecycle stages — executed through trusted workflows, governed tooling, and structured learning from every approval, edit, and outcome.**

Commodity layers (base orchestration, raw prompt generation, content drafting, standard dashboards) are intentionally outsourced to Paperclip and SmarterMCP. GrowthOS owns the domain layer: motion intelligence, confidence scoring, structured memory, experiment-driven learning, attribution, and the founder trust surface. These are the layers that compound.