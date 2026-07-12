# GrowthOS v4 — Stack Decisions

**Companion to:** `Growthos_v4.md` (strategic spec), `Growthos_v4_Technical_Architecture.md` (architecture), `paperclip_guide.md` (control plane), `anatomy_of_agentic_harness.md` (harness principles), `SmarterMCP_guide.md` (disabled legacy reference)
**Audience:** Founder, platform engineers, design lead
**Status:** Opinionated, OSS-first, self-hostable blueprint

---

## 0. Non-negotiable design principles

1. **Paperclip is the harness.** Companies, agents, issues, documents, routines, approvals, heartbeat-runs are the primitives. We extend; we do not reinvent.
2. **Filesystem is the memory spine.** Skills, claims, evidence bundles, founder voice, playbook versions — all files in a tenant-scoped git repo. The database indexes the filesystem; it is not the source of truth for agent-readable artifacts.
3. **Skills = progressive disclosure.** Motion activation loads only manifests; full skill body is fetched JIT when the agent actually needs it. Direct application of the anatomy doc's context-rot mitigation.
4. **Sandboxes are first-class.** Research, scraping, content verification, outbound enrichment all run in isolated workspaces with bash + browser + code exec. Not optional.
5. **Event-driven means durable + replayable.** Persistent streams with consumer groups and offsets. Learning Director replays 90-day-old events when a pattern is hypothesized.
6. **UI is operator-grade.** Linear / Height / Raycast / Campsite are the reference aesthetics. Information-dense, keyboard-first, real data viz, grayscale + one accent, zero gradients, zero emojis.
7. **100% self-hostable** on a single Kubernetes cluster (K3s) or Docker Compose. No managed-service lock-in in the critical path.
8. **Hot paths in Rust; velocity in TypeScript.** Targeted, not ideological.

---

## 1. Harness primitives → realization

| Anatomy primitive | GrowthOS realization |
|---|---|
| Filesystem | Per-tenant **Gitea** repo (`growthos-ws-{tenant}`) + MinIO for large artifacts. Agents read/write via MCP fs tools. `git log` is the free audit trail for playbook evolution. |
| Bash + code as general tool | Per-run **Daytona** (or self-hosted E2B) sandbox: bash, python, node, playwright preinstalled. |
| Sandboxes with defaults | Per-motion sandbox images. `inbound` ships with CMS CLIs, schema validators, GEO probe scripts. `outbound` ships with enrichment libs, CRM CLIs. `community` ships with anti-detect Playwright profiles. |
| Memory + search | Filesystem-first `FOUNDER.md` loaded at agent start. **Qdrant** for dense retrieval across learnings + claims + memory. **Meilisearch** for BM25 over approval queue, signals, run logs. |
| Context rot mitigation | n8n passes normalized webhook payloads and artifact URLs/object references instead of large vendor responses. Skills loaded progressively via manifest-then-body. Compaction summaries written as Paperclip issue documents. |
| Ralph loops | Learning Director and Weekly Review are Ralph loops: a hook detects early-stop, reinjects goal into a fresh run, continues from filesystem state. Paperclip routines + Temporal/Restate `continueAsNew` realizes this. |
| Planning + self-verification | Plan file = Paperclip issue document (`key=plan`). Self-verification = the confidence critic, backed by structured rubrics stored in git. |
| JIT tool assembly | GrowthOS exposes only n8n ingress/dispatch contracts to agents. Downstream SaaS access is controlled by n8n workflows and GrowthOS approval policy. |

---

## 2. Paperclip: keep, extend, replace

### Keep verbatim
- Companies / agents / issues / comments / documents / attachments / routines / approvals / heartbeat-runs / wakeup.
- Execution-policy stages (review/approval) → map directly to P0–P4 tiers.
- MCP server (`paperclipMe`, `paperclipCheckoutIssue`, `paperclipUpsertIssueDocument`, …) — agents talk Paperclip via MCP, not REST.
- `adapterType` model — we register `growthos_native` alongside `claude_local`.
- Org chart, chain of command, budget tracking (`budgetMonthlyCents`).
- Issue identifier convention (e.g. `GRO-42`) as stable external reference.

### Extend (additive PRs to the fork)
- RLS + tenant isolation on every Paperclip table.
- **Restate/Temporal-backed scheduler** replacing the in-process timer.
- **NATS JetStream** replacing the custom Redis Pub/Sub fan-out from tech-spec §3.6.
- Custom execution-policy stages: `growthos.confidence_gate`, `growthos.warmth_gate`, `growthos.claims_gate`, `growthos.geo_gate`.
- MCP tool extensions: `paperclipFileRead/Write` (Gitea workspace), `paperclipSkillLoad` (JIT skill body), `paperclipEvidencePin` (immutable evidence bundle), `paperclipPlaybookDiff`.
- Heartbeat-run event stream → ClickHouse for analytical drill-down.

### Replace
- Paperclip default UI is a v0 shell. We fork it but rebuild every founder surface (motion scoring, approval queue, experiment dashboard, weekly review, playbook diff). Paperclip UI is dev-tool-grade; GrowthOS is a founder product.
- Embedded Postgres is fine for `paperclipai onboard` but production uses external Postgres 16 + pgvector + pg_partman.

---

## 3. Backend stack

| Concern | Choice | Why |
|---|---|---|
| Hot-path language | **Rust** for Signal Router, Confidence Scorer fast-path, Attribution Aggregator, outbox-publisher | Sub-50ms tail latencies TS can't reliably hit |
| Glue language | **TypeScript 5 / Node 22**, monorepo via **pnpm + Turborepo + Biome** | Paperclip is TS; most workers don't need Rust |
| Domain layer | **Effect-TS** | Typed errors, structured concurrency, retries, DI without a framework |
| API | **Hono** + **@hono/zod-openapi** + **tRPC v11** (intra-monorepo) | Edge-portable, typed, auto-OpenAPI |
| Durable execution | **Restate** (primary) or **Temporal** | Both fully OSS, self-hostable. Restate simpler/TS-native; Temporal proven at scale. Neither is BullMQ. |
| Streams + queue + pub/sub | **NATS JetStream** | Replaces BullMQ + Redis Pub/Sub + custom outbox-relay. Persistent, replayable, consumer groups, built-in KV + object store, subject-based tenant isolation (`t.{tenant}.{domain}.{event}`). |
| Outbox bridge | **outbox-publisher** (Rust, leader-elected via NATS KV) | Single-binary Postgres outbox → JetStream bridge |
| ORM | **Drizzle ORM** | RLS-friendly, Zod inference, zero runtime overhead. Not Prisma. |
| Validation | **Zod v4** | One schema → runtime validation + types + JSON schema for MCP tools + OpenAPI |

---

## 4. Data layer

| Workload | Store | Why |
|---|---|---|
| OLTP: agents, issues, approvals, motion_stack, experiments, memory | **Postgres 16 + pgvector (HNSW)** | HNSW not IVFFlat. Logical replication for outbox. |
| Time-series: `activity_log`, `cost_events`, `attribution_touchpoints`, `experiment_observations`, `geo_citations`, heartbeat events | **ClickHouse** (OSS) | Postgres + pg_partman will not hold at 1k tenants × millions of events. Founder drill-downs stay <100ms. |
| Vectors at scale (learnings, claims, memory) | **Qdrant** (Rust, OSS) | Better recall + update performance than pgvector at scale. Keep pgvector for small motion-local indexes. |
| Full-text + faceted search | **Meilisearch** or **Typesense** | 20ms founder search over signals, approvals, evidence. Postgres FTS acceptable at v1. |
| Object store | **MinIO** (OSS, S3-API) | Self-hostable, erasure-coded |
| Agent filesystem | **Gitea** (OSS) per-tenant repos | Git = free versioning for skills, playbooks, claims |
| Cache | **Valkey** (OSS Redis fork) or Redis 7 OSS | Cache only. NOT queues, NOT pub/sub. |

---

## 5. UI: the anti-slop layer

Tell-tale signs of AI-slop UI — purple gradients, emoji prefixes, shadcn-default cards, lucide icons everywhere, marketing microcopy, modal-stacks — are banned by design-system rules, not by taste.

### Foundations
| Layer | Choice |
|---|---|
| Framework | **Next.js 15 (App Router, RSC)** |
| Routing escape hatch | **TanStack Router** for standalone SPA zones (e.g., approval queue) |
| Unstyled primitives | **Radix Primitives + Ark UI + React Aria Components** (NOT shadcn/ui) |
| Styling | **Vanilla Extract** (zero-runtime CSS-in-TS) + CSS variables, OKLCH tokens |
| Typography | **Geist Sans + Mono** (self-hosted, OFL) or **Inter Display** |
| Icons | **Lucide** customized into a house set of ~60 |
| Motion | **Motion** (formerly Framer Motion) — only for state transitions, no decoration |
| Command menu | **cmdk** (⌘K mandatory, Linear-style) |
| Keyboard | **react-hotkeys-hook** + documented global bindings (`j/k` nav, `a` approve, `e` edit, `x` reject, `⌘⏎` submit) |

### Specialized surfaces
| Surface | Choice |
|---|---|
| Approval-queue diff editor | **TipTap** (ProseMirror) + `prosemirror-changeset` — inline edits, natural `edit_distance` capture |
| Skill/playbook editor | **CodeMirror 6** + markdown mode + custom frontmatter lints |
| Motion health / experiment posteriors / warmth gradients | **Visx** + D3 selection (custom) — never Recharts/Tremor defaults |
| Tables | **TanStack Table + TanStack Virtual** — no AG-Grid |
| Forms | **React Hook Form + Zod + conform** for server actions |
| Realtime | Thin WS gateway over NATS JetStream — not Supabase Realtime |
| Docs site | **Fumadocs** (Next.js MDX, OSS) — not Mintlify |
| Auth UI | Custom over Zitadel/Authentik OIDC |

### Design system
- Repo: `@growthos/design-system` — tokens, primitives, compositions, Storybook 8.
- Reference aesthetics: **Linear** (density + keyboard), **Height** (data density), **Raycast** (command-driven), **Campsite** (quiet polish), **Arc** (spatial), **Plausible** (restraint).
- Tokens: **OKLCH** color space, 4-point spacing, 3 type sizes on any view.
- Color: grayscale + one semantic accent per surface (blue info, amber pending, red destructive only). **No gradients. No glassmorphism.**
- Copy: no marketing voice, no emoji, no em-dashes for flair. "Approve and dispatch" > "✨ Approve and let's go!"
- Density: list item 32px, table row 36px. Not 56px.
- **Storybook + Chromatic** visual regression; **axe-core** a11y in CI; **Stryker** mutation tests on policy/scoring code.

---

## 6. Realtime, events, outbox

```
Postgres domain mutation (TX)
  └─ event_outbox insert
Postgres NOTIFY 'outbox.ready'
  └─ outbox-publisher (Rust, leader-elected via NATS KV)
NATS JetStream subjects (t.{tenant}.{domain}.{event})
  ├─ ws-gateway (Node/Hono) → founder UI (WS/SSE), gap backfill via JetStream replay
  ├─ worker-learning (consumer group, per-tenant offsets)
  ├─ worker-attribution (nightly batch from stream offset)
  └─ external webhook delivery (future)
```

### Why NATS JetStream over Redis Pub/Sub + custom relay
- Persistent streams with replay from any offset → Learning Director re-derives 90-day patterns without DB scans.
- Subject-based tenant isolation matches Redis-prefix model.
- Consumer groups + offset tracking — exactly what you'd build on top of Pub/Sub, for free.
- JetStream KV replaces Redis for leader locks and presence.
- Single binary, ~50MB, clusters out of the box.
- Built-in WS + MQTT transports — SSE-fallback concern disappears.

---

## 7. LLM + agent layer

| Concern | Choice |
|---|---|
| Model router + budget | **LiteLLM** (self-hosted proxy) — tenant-scoped keys, per-model fallbacks, per-request budgets, prompt caching |
| Agent SDK | **Vercel AI SDK v5** in the adapter; direct Anthropic SDK for producer, OpenAI-compatible for critic |
| Trace + eval store | **Langfuse** (self-hosted, AGPL) — prompt versions, traces, dataset + eval runner |
| Offline evals | **Promptfoo** (OSS MIT) in CI; Langfuse datasets for live replay |
| Prompt + skill store | **Git (Gitea)** — Langfuse references git SHAs; no duplicated source of truth |
| Sandboxes | **Daytona** or **E2B** OSS — per-run container with fs + bash + browser |
| External integration runtime | **n8n** as the single connector fabric; GrowthOS talks to n8n through signed webhooks/API |
| DLP | GrowthOS policy checks before approval/dispatch; optional Presidio stage in n8n workflows for vendor payloads |
| Structured output | **Zod** + model-native structured output — avoid Guardrails AI overhead |

---

## 8. Platform layer (all OSS, self-hosted)

| Concern | Choice | Why |
|---|---|---|
| Identity | **Zitadel** (OSS, Apache 2.0, Go) or **Authentik** | OIDC, SSO, multi-tenant orgs. Replaces Clerk. |
| Billing | **Lago** (OSS, usage-based) + Stripe as the card rail only | GrowthOS prices on approved actions/motions/tracked accounts — Lago is purpose-built for this |
| Secrets | **OpenBao** (OSS Vault fork) or **Infisical** self-hosted | Per-tenant KMS-wrapped secrets, dynamic DB creds |
| Observability | **SigNoz** (single binary, OTel-native) OR **Grafana LGTM** (Loki/Mimir/Tempo/Pyroscope) | OTel everywhere |
| Error tracking | **GlitchTip** (OSS Sentry fork) or self-hosted Sentry | GlitchTip is BSD |
| Flags + experiments | **GrowthBook** (OSS, Bayesian stats) self-hosted | §6.4's Bayesian evaluator *is* GrowthBook |
| Transactional email | **Postal** (OSS) or SES as SMTP rail |
| Lifecycle email | **Listmonk** (bulk) + **Novu** (in-app + multi-channel) |
| Deploy | **K3s** + **Argo CD** + **Argo Rollouts** OR **Coolify** for v1 | Avoid full k8s complexity until phase 2 |
| IaC | **Pulumi** (TS) or **OpenTofu** |
| CI/CD | **GitHub Actions** (primary) or **Woodpecker CI** (Gitea-native, fully OSS) |

---

## 9. Performance + scale targets

- **Signal → dispatch P95 < 60s** at 1000 tenants × 10 sig/s → Rust Signal Router + JetStream fan-out + Restate dispatch.
- **Approval queue page load P95 < 300ms** (tightened from spec's 800ms) → RSC streaming + TanStack virtual + ClickHouse aggregates + Meilisearch index.
- **Outbox → WS delivered P95 < 200ms** → NATS ack → WS push, single broker hop.
- **Heartbeat cold start < 2s** → skill manifest + memory resolver cached; full skill body fetched JIT.
- **Learning Director 90-day replay < 5 min/tenant** → ClickHouse + JetStream replay; Postgres never scanned.

---

## 10. Condensed stack

```
UI
  Next.js 15 (App Router, RSC) • TanStack Router/Query/Table/Virtual
  Radix + Ark UI + React Aria (NOT shadcn) • Vanilla Extract
  TipTap (diff editor) • CodeMirror 6 (skill editor) • Visx (charts)
  cmdk • Motion • Geist • Storybook 8 + Chromatic

API + domain
  Hono + @hono/zod-openapi + tRPC v11
  Effect-TS (domain services) • Drizzle ORM • Zod v4

Harness
  Paperclip fork (companies/agents/issues/docs/routines/approvals) +
    growthos_native adapter + growthos.* execution-policy stages
  n8n connector fabric + signed GrowthOS webhooks + optional Presidio DLP stage
  LiteLLM (model router) + Langfuse (traces) + Promptfoo (evals)
  Daytona / E2B sandboxes (bash/browser/code)
  Gitea per-tenant workspace (skills, playbooks, evidence, reviews)

Durable execution + events
  Restate (or Temporal) — durable workflows
  NATS JetStream — streams, queues, KV, leader locks, WS fan-out
  outbox-publisher (Rust) — Postgres outbox → JetStream bridge

Data
  Postgres 16 + pgvector (HNSW) • Drizzle + Atlas/pgroll
  ClickHouse (time-series, attribution, analytics)
  Qdrant (vectors at scale)
  Meilisearch (FTS + facets)
  Valkey/Redis 7 (cache only) • MinIO (objects) • Gitea (agent fs)

Hot paths in Rust
  Signal Router • Confidence Scorer fast-path
  outbox-publisher • attribution aggregator

Platform
  Zitadel (auth) • Lago + Stripe (billing) • OpenBao (secrets)
  SigNoz or Grafana LGTM (obs) • GlitchTip (errors) • GrowthBook (flags + exp)
  Postal + Listmonk + Novu (messaging)
  K3s + Argo CD + Argo Rollouts (or Coolify for v1)
  Pulumi / OpenTofu (IaC) • GitHub Actions / Woodpecker CI

Testing
  Vitest • Testcontainers • Playwright • k6 • Toxiproxy
  Storybook + Chromatic (or Ladle) • axe-core • Stryker (mutation on policy code)
  Promptfoo + Langfuse datasets (LLM evals)
```

---

## 11. Open decisions to close before Phase 1

1. **Restate vs Temporal.** Restate is simpler, TS-native, handlers look like regular functions. Temporal is proven at scale, multi-language, bigger community. Decide by team size and scale timeline.
2. **Coolify (v1) vs K3s (day 1).** Coolify to production in a week; K3s is the right long-term home but needs platform-engineer attention. If first 5 tenants are friends-and-family, Coolify. If fundraising on infra credibility, K3s.
3. **Qdrant now vs pgvector HNSW first.** pgvector is adequate under ~1M vectors/tenant. Start pgvector, have the migration plan on file.
4. **Effect-TS adoption depth.** Powerful and future-proof, steep learning curve. If team ≤3 engineers, keep it optional. If hiring a platform team, adopt now.
5. **Gitea per tenant vs shared Gitea, per-tenant repos.** Per-tenant repos inside a shared, access-controlled Gitea is the pragmatic middle path.
6. **Rust at Phase 1 vs Phase 2.** Phase 1 can be TS-only; introduce Rust when Signal Router P95 starts drifting. Do not introduce Rust just to look future-gen.

---

## 12. Why this buys the "future-gen" posture

1. **No orchestration theater.** Restate/Temporal owns durable execution; NATS owns streams. No hand-rolled state machines, no leader-elected relay code.
2. **Replay is free.** JetStream offsets + ClickHouse + Git history → the Learning Director can re-derive patterns from any point in time.
3. **Filesystem-as-primitive is realized, not metaphorical.** Gitea per tenant is the single source of agent-readable truth for skills, claims, playbooks, evidence. Postgres indexes over it.
4. **Sandboxes are first-class.** Every agent run gets an isolated workspace. Warm outbound runs Playwright; content verifies its own claims; intel diffs competitor pages.
5. **UI is operator-grade by construction.** Radix + Vanilla Extract + Visx + TipTap + CodeMirror + cmdk is the Linear/Raycast/Height pattern. Shadcn-default is avoided as a positive choice.
6. **Everything self-hostable on one K3s cluster.** Zero vendor criticality. Provider outage or price hike → move a Helm chart.
7. **Rust where latency compounds; TS where velocity matters.** Targeted, not ideological.

---
