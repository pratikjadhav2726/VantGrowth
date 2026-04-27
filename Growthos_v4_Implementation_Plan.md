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

**Last updated:** 2026-04-27

### Progress dashboard (implementation status)

| Phase / Track | Status | Progress |
|---|---|---:|
| Phase 0 / Track A (Repo + tooling) | In progress, strong foundation complete | 70% |
| Phase 0 / Track B (Data plane) | In progress (core schema baseline + contracts started) | 15% |
| Phase 0 / Track C (Event + workflow plane) | In progress (Postgres outbox + NATS publisher started) | 20% |
| Phase 0 / Track D (LLM + harness infra) | Not started | 0% |
| Phase 0 / Track E (Identity/billing/secrets/deploy) | Not started | 0% |
| Phase 0 / Track F (Paperclip fork hardening) | Fork present, hardening not complete | 20% |
| Phase 1 / S1 (Adapter + tenant provisioning starter) | In progress (adapter/API scaffolding complete) | 40% |
| Phase 1 / S2 (Motion Engine starter) | In progress (deterministic scorer v1 starter complete) | 30% |
| Phase 1 / S3-S6 (Agents/UI/learning loop) | Not started | 0% |

### Completed in code (this repo)

- **Phase 0 / Track A (Repo + tooling)**
  - Monorepo scaffolded with `pnpm`, `turbo`, `typescript`, `biome`, `vitest`.
  - Packages created: `@growthos/core`, `@growthos/api`, `@growthos/adapter`, `@growthos/skills`, `@growthos/design-system`, `@growthos/test-utils`.
  - Workspace validation commands are green (`pnpm typecheck`, `pnpm test`).
- **Phase 1 / S2 Domain starter**
  - Deterministic `Motion Engine` starter implemented in `@growthos/core` with versioned scorer output and tests.
- **Phase 0 / Track B Data-plane starter**
  - `@growthos/db` package added.
  - Core SQL migration baseline added for `motion_scores`, `motion_stack`, `approval_feedback`, and `event_outbox`.
  - RLS policies and idempotency constraint included in migration contract.
  - Typed outbox contracts, tenant context helpers, and in-memory outbox repository implemented with tests.
  - Real Postgres outbox repository implemented with transaction-local RLS context and idempotent insert/load behavior.
- **Phase 0 / Track C Event-plane starter**
  - `@growthos/worker-signal-router` app added.
  - Real NATS JetStream publisher implemented using the `nats` client.
  - Signal Router service implemented with deterministic stage-1 classification, outbox enqueue, and tenant-scoped NATS publishing.
  - Worker tests cover routing, duplicate signal idempotency, and JetStream publish boundary.
- **Phase 1 / S1 Adapter starter**
  - `growthos_native` adapter contract scaffolded in `@growthos/adapter`.
  - Typed `PaperclipClient` implemented (company, agent, issue, checkout, release, wakeup operations).
  - Env-driven config parsing implemented (`PAPERCLIP_BASE_URL`, `PAPERCLIP_SERVICE_TOKEN`, `PAPERCLIP_TIMEOUT_MS`).
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

- **Phase 0 / Track B** data plane provisioning and migrations (`Drizzle`, `Atlas`, Postgres schemas) not yet implemented.
- **Phase 0 / Track C** durable event/workflow plane (`NATS JetStream`, `Restate`, outbox publisher) not yet implemented.
- **Phase 0 / Track D/E** LLM gateway deployment, secrets, identity, billing, and GitOps deploy tracks not yet implemented.
- **Phase 0 / Track F** Paperclip fork hardening deltas (RLS, scheduler migration, LiveEvents replacement) are not yet merged/verified in the fork.
- **Phase 1 agents/workers/UI** (Intel/Inbound/Reporting, critique worker, approval queue UI, weekly review) not yet implemented.

### Active next milestones (execution order)

1. Implement `growthos` schema migrations + repository layer (Postgres/Drizzle).
2. Implement first async workers (`worker-signal-router`, `worker-critique`) with idempotent job contracts.
3. Start Paperclip fork hardening branch execution (RLS + scheduler + live-events), then run integration smoke.
4. Add live infrastructure smoke tests for Postgres + NATS once local services are running.

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
