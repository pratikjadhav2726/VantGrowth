# GrowthOS v4 — End-to-End Walkthrough

> A concrete trace of one tenant — **Avery Chen, founder of Lattice (devtools, ACV $12k, team of 4)** — from signup through first approved action through the first closed learning loop.
>
> Every step shows: **wall-clock time**, **what the founder sees**, **API calls** (Paperclip + GrowthOS), **NATS subjects emitted**, **DB writes** (SQL), **Gitea commits**, and **LLM calls** (model + rough token cost). All times are local to Avery (PT). All identifiers are illustrative.
>
> Read this alongside `Growthos_v4_Technical_Architecture.md` (system topology), `Growthos_v4_Stack_Decisions.md` (tooling rationale), and `Growthos_v4_Implementation_Plan.md` (build order).

---

## Cast of components referenced

| Surface | Role in this trace |
|---|---|
| **Web app** (Next.js 15 RSC) | What Avery sees |
| **api** (Hono + Zod-OpenAPI) | Public REST/tRPC surface |
| **paperclip-core** | Companies, agents, issues, documents, approvals, heartbeats |
| **scheduler** | Cron + signal-driven heartbeat dispatcher |
| **worker-signal-router** | Classifies + routes signal_events into typed signals |
| **worker-heartbeat** | Runs the per-agent harness (Ralph loop + skills + memory) |
| **worker-critique** | Confidence scorer + self-critique |
| **worker-learning** | Distills feedback into gtm_learnings |
| **n8n** | Single connector fabric for downstream SaaS workflows |
| **NATS JetStream** | All async fan-out, queues, KV, leader locks |
| **Postgres 16 + pgvector** | System of record (RLS per company_id) |
| **Gitea** | Per-tenant agent filesystem (skills, memory, plans, drafts) |
| **Qdrant** | Vector recall over memory + content claims |
| **ClickHouse** | activity_log, signal_events, motion_scores time-series |
| **MinIO** | Attachments, raw scrape blobs, eval artifacts |
| **Daytona** | Sandboxes for code-running agents (not used in this trace) |
| **Langfuse** | Trace + token + cost capture for every LLM call |
| **GrowthBook** | Feature gates + Bayesian experiments |

NATS subject convention: `gos.<bounded-context>.<event>.v1` — versioned, typed via Zod, validated by the producer.

---

## T+0 — Monday 09:00:00 PT — Avery signs up

**What Avery sees:** `app.growthos.dev/signup` → Zitadel hosted login → 4-question onboarding (company name, website, ICP one-liner, "what do you sell"). She types: *"Lattice — open-source feature flag service for backend teams. We sell to platform engineers at Series A–C SaaS companies. ACV ~$12k."*

### 09:00:12 — Tenant provisioning (sync, blocking, <2s)

`POST /v1/tenants` (api → Hono handler)

```sql
-- All writes inside one transaction; emits one outbox row.
INSERT INTO tenants (id, name, plan, created_at) VALUES ($1, 'Lattice', 'starter', now());
INSERT INTO users (id, tenant_id, email, role) VALUES ($2, $1, 'avery@lattice.dev', 'owner');
INSERT INTO event_outbox (id, subject, payload, created_at)
  VALUES (gen_random_uuid(), 'gos.tenant.created.v1',
          jsonb_build_object('tenant_id', $1, 'plan', 'starter'), now());
```

The outbox-relay (a Postgres LISTEN/NOTIFY consumer) publishes to NATS within ~50ms:

```
SUBJECT: gos.tenant.created.v1
PAYLOAD: { "tenant_id": "ten_lat_01", "plan": "starter" }
```

Three consumers react in parallel:

| Consumer | Action |
|---|---|
| `paperclip-bootstrap` | Calls Paperclip to create the company shell |
| `gitea-bootstrap` | Creates `lattice/agent-fs` repo, seeds skeleton |
| `qdrant-bootstrap` | Creates per-tenant Qdrant collection `mem_ten_lat_01` |

### 09:00:13 — Paperclip company creation

```bash
POST https://paperclip.gos.internal/v1/companies
Authorization: Bearer $PAPERCLIP_SVC_TOKEN
{
  "externalId": "ten_lat_01",
  "name": "Lattice",
  "metadata": { "plan": "starter", "icp_seed": "...", "domain": "lattice.dev" }
}
→ 201 { "id": "cmp_LAT_01", "identifier": "LAT" }
```

### 09:00:14 — Gitea bootstrap

`gitea-bootstrap` clones the `growthos/agent-fs-template` repo and pushes to `lattice/agent-fs` as the initial commit:

```
agent-fs/
├── AGENTS.md                      # tenant-wide instructions, regenerated each heartbeat
├── company/
│   ├── profile.md                 # ICP, tone, claims allowlist (filled at T+15min)
│   └── motion_stack.md            # confirmed motions (filled at T+15min)
├── agents/
│   └── .gitkeep                   # populated when agents are minted
├── skills/                        # progressive-disclosure skill packs (front-matter only loaded at start)
│   ├── inbound-content/
│   ├── outbound-multichannel/
│   ├── community-engagement/
│   ├── intel-sweep/
│   └── lifecycle-nurture/
└── memory/                        # mirrored into Qdrant; canonical text lives here
    ├── company_memory.md
    └── feedback_journal.md
```

Commit message: `bootstrap: lattice tenant, template v0.4.2`. SHA pinned in `tenants.agent_fs_sha`.

### 09:00:14 — Founder UX during this 2 seconds

Avery sees a Linear-style 4-step progress sheet (Vanilla Extract, OKLCH neutrals, no spinners — discrete check marks):

```
✓ Workspace ready
✓ Agent filesystem provisioned
✓ Memory store initialized
○ Calibrating motion mix…
```

The fourth step is async — she's redirected to `/onboarding/discovery` while it runs.

---

## T+90s — 09:01:30 PT — Discovery sweep dispatched

The signup handler enqueued one durable workflow on Restate:

```
restate.workflow: discovery_sweep.v1
input:  { tenant_id: "ten_lat_01", icp_seed, domain: "lattice.dev" }
timeout: 12 minutes  (hard ceiling; UI tells her "ready in <15 min")
```

The workflow steps (each is a NATS request/reply with at-least-once + idempotency key):

1. `gos.intel.scrape_site.v1` → fetches lattice.dev, github.com/lattice, blog, pricing → MinIO blobs.
2. `gos.intel.profile_company.v1` → LLM extracts positioning, claims, social proof, current channels.
3. `gos.intel.score_motions.v1` → scores all 8 motions for fit.
4. `gos.intel.draft_motion_stack.v1` → drafts a recommended 3-motion stack.
5. `gos.tenant.discovery_complete.v1` → signals UI to switch from "calibrating" to "review".

### Step 1 — Scrape (parallel, ~30s)

n8n runs the configured discovery workflow, calls downstream scrape/search services, and sends GrowthOS a normalized signed signal with artifact URLs/object references. Output is cached in MinIO (`raw/ten_lat_01/scrape/<sha>.html.gz`) for 30 days. Cost: $0.004.

### Step 2 — Profile company (~25s, ~6k input / ~1.5k output tokens)

```
LiteLLM route: positioning.profile.v1
→ provider: anthropic, model: claude-sonnet-4-6
→ Langfuse trace: tr_disc_lat_01
```

Emits structured output:

```json
{
  "positioning": "Open-source feature flags for backend platform teams who...",
  "claims_extracted": [
    {"text": "p99 evaluation under 1ms", "source_url": "lattice.dev/perf", "verifiable": true},
    {"text": "Used by 800+ teams", "source_url": "lattice.dev", "verifiable": false}
  ],
  "current_channels": ["github", "hn", "discord"],
  "social_proof": [...],
  "competitor_set": ["LaunchDarkly", "Statsig", "Unleash", "Flagsmith"]
}
```

Written to `gtm_learnings` as `kind=positioning_baseline` (frozen ground truth for future eval).

Two writes happen in the same Postgres transaction:
- Insert into `content_claims` (one row per extracted claim, `verifiable` flag set).
- Commit to Gitea: `company/profile.md` rewritten with the structured profile + claims table. Gitea SHA stored in `tenants.profile_sha`.

### Step 3 — Motion scoring (~15s, ~4k tokens)

The Motion Engine runs a typed scorer (LLM-assisted but bounded — 8 prompts × 500 tokens each, batched). Each motion gets a score 0–1 with a rationale. Inserted into `motion_scores`:

```sql
INSERT INTO motion_scores (tenant_id, motion, score, rationale, scored_at)
VALUES
  ('ten_lat_01', 'inbound_content',     0.84, 'OSS positioning + dev audience...', now()),
  ('ten_lat_01', 'community_engagement', 0.78, 'Active Discord + GitHub presence...', now()),
  ('ten_lat_01', 'lifecycle_expansion',  0.71, 'Self-serve trial → team conversion lever...', now()),
  ('ten_lat_01', 'outbound_multichannel',0.42, 'Small team; ACV too low for SDR economics yet', now()),
  ...
```

### Step 4 — Draft motion stack (~10s)

Top-3 with rationale + suggested first agents per motion:

```sql
INSERT INTO motion_stack (tenant_id, version, motions, status, drafted_at)
VALUES ('ten_lat_01', 1,
  '{"motions": [
     {"id":"inbound_content","agents":["inbound_content_strategist"]},
     {"id":"community_engagement","agents":["community_engagement_lead"]},
     {"id":"lifecycle_expansion","agents":["lifecycle_engineer"]}
   ]}'::jsonb,
  'draft_pending_review', now());
```

### Step 5 — Discovery-complete event

```
SUBJECT: gos.tenant.discovery_complete.v1
PAYLOAD: { "tenant_id": "ten_lat_01", "motion_stack_version": 1 }
```

The ws-gateway (NATS → WebSocket fan-out) pushes a `discovery_ready` event to Avery's open session.

---

## T+15min — 09:15:00 PT — Avery reviews her motion stack

**What Avery sees:** A two-column page. Left: the three recommended motions with confidence bars (Visx, OKLCH chroma stepped) and a one-paragraph rationale each. Right: the five motions she's *not* running, with rationale (this is important — she sees what was rejected and why). Bottom: a single "Confirm & launch motions" button. No dropdowns, no settings panel, no "advanced configuration" — just confirm or click any motion to expand and edit the agent assignment.

She expands `inbound_content`, sees the agent that will be minted (`Inbound Content Strategist`), accepts the default monthly budget ($45/mo for this agent), and clicks **Confirm**.

### 09:15:08 — Motion confirmation cascades

`POST /v1/tenants/ten_lat_01/motions/confirm`

```sql
UPDATE motion_stack SET status='active', confirmed_at=now()
  WHERE tenant_id='ten_lat_01' AND version=1;

INSERT INTO event_outbox (subject, payload) VALUES
  ('gos.motion_stack.confirmed.v1',
   '{"tenant_id":"ten_lat_01","version":1,"motions":[...]}');
```

The NATS event fans out to three consumers, one per motion. Each calls Paperclip to mint its agent:

```bash
POST https://paperclip.gos.internal/v1/agents
{
  "companyId": "cmp_LAT_01",
  "name": "Inbound Content Strategist",
  "adapterType": "growthos_native",
  "budgetMonthlyCents": 4500,
  "metadata": {
    "motion": "inbound_content",
    "skill_pack": "inbound-content@0.4.2",
    "policy_tier_default": "P2"
  }
}
→ 201 { "id": "agt_LAT_INB_01", "identifier": "LAT-INB" }
```

For each minted agent, `worker-heartbeat` performs the **agent provisioning ritual** (one Gitea commit per agent):

```
agent-fs/agents/agt_LAT_INB_01/
├── AGENTS.md          # agent identity + scope + memory pointers (regenerated each heartbeat)
├── plan.md            # current plan (empty at mint)
├── inbox.md           # signals routed to this agent (empty)
├── drafts/            # draft outputs before approval
└── memory_pointers.md # qdrant collection refs + filters
```

Commit: `mint: agt_LAT_INB_01 (Inbound Content Strategist)`.

A `confidence_scores` baseline row is inserted (`agent_confidence=0.5`, `motion_confidence=0.5`, `tenant_confidence=0.5`). The Confidence Scorer treats all three as priors that update as approvals/rejections accumulate.

### 09:15:10 — Scheduler arms the agents

The scheduler (a Restate workflow + NATS KV leader lock — at-most-one scheduler instance per tenant) registers:

- A 6-hour cron heartbeat for each agent (jittered ±15min to prevent thundering herd).
- A signal-driven trigger: any `gos.signal.*` event matching the agent's `signal_subscriptions` wakes it within its policy SLA.
- A first heartbeat dispatched immediately for each agent.

---

## T+18min — 09:18:00 PT — Intel Director's first sweep

The Intel Director is a system agent (one per tenant, minted at T+0). Its first heartbeat fires now. It runs in the `growthos_native` adapter via `worker-heartbeat`.

### Heartbeat lifecycle (this is the harness)

`worker-heartbeat` claims the heartbeat from a NATS JetStream consumer (`durable_name=worker-heartbeat`, `max_deliver=3`, `ack_wait=5min`). For agent `agt_LAT_INT_01`:

1. **Atomic checkout** — `POST /v1/issues/checkout` against Paperclip. If no issue is currently assigned, create one: *"Run scheduled intel sweep — sweep_id=2026-04-22T16:18Z"*. Returns issue `LAT-1` with checkout token (TTL 30min, single-writer guarantee).

2. **Filesystem assembly** — `git clone --depth 1 lattice/agent-fs` into a Daytona-managed ephemeral workspace (~400ms, cached layer). Pin to commit SHA stored in the agent's last heartbeat record.

3. **AGENTS.md regeneration** — the harness writes a fresh `agents/agt_LAT_INT_01/AGENTS.md` containing:
   - Agent identity (Paperclip metadata)
   - Current motion stack (from Postgres)
   - Active issue (LAT-1) + recent comments
   - Memory pointers (top-K Qdrant queries against `mem_ten_lat_01` filtered by `agent_id=agt_LAT_INT_01 OR scope=tenant`)
   - Connector boundary (GrowthOS receives normalized n8n signals and can only enqueue approved dispatch actions)
   - Skill front-matter (progressive disclosure — full skill bodies loaded only when invoked)
   - Plan pointer + recent activity log tail (last 50 lines)

4. **Skills resolver** — Skill front-matter (~80 tokens each) is loaded into the system prompt; bodies stay in `skills/` and are pulled into context only when the model calls `load_skill(name)`. This protects against context rot per the harness anatomy doc.

5. **Memory resolver** — Qdrant query: top-20 memory items by cosine similarity to a synthesized query (`positioning + competitor_set + last 30 days of signal_events`), filtered to `tenant_id=ten_lat_01`. Loaded into AGENTS.md as `## Recent Memory`.

6. **Ralph loop** — the agent runs. Up to N steps (default 12), with a hook that intercepts attempted `exit` and reinjects the goal if work is incomplete.

### What the Intel Director actually does in this heartbeat (~3 minutes)

The model (claude-sonnet-4-6 via LiteLLM) works from normalized n8n signals and GrowthOS memory:

| Step | Tool | Cost |
|---|---|---|
| 1 | `competitor_track.diff` (LaunchDarkly, Statsig, Unleash) — checks pricing pages, blogs, GitHub releases since last sweep (here: since epoch) | $0.01 |
| 2 | Reads cached output: LaunchDarkly raised pricing on the Pro plan from $20→$32/seat, effective last Friday | $0 |
| 3 | `web_search.recent` — "LaunchDarkly pricing change reaction site:reddit.com OR site:news.ycombinator.com" | $0.02 |
| 4 | Reads 4 HN comments + 1 Reddit thread: meaningful pricing-driven churn signal | $0 |
| 5 | Drafts an **opportunity brief** as a Paperclip document on issue LAT-1 | LLM ~$0.04 |

The opportunity brief is upserted as a versioned Paperclip document:

```bash
POST https://paperclip.gos.internal/v1/issues/LAT-1/documents
{
  "key": "opportunity_brief",
  "title": "LaunchDarkly Pro pricing 60% increase — inbound content + outbound trigger",
  "body": "# Signal\n\nLaunchDarkly raised Pro plan pricing from $20→$32/seat...\n\n# Why this matters for Lattice\n\n- Self-hosted OSS positioning lands harder this week...\n- Comparison content has elevated demand...\n\n# Recommended actions\n\n1. **Inbound Content Strategist** — comparison post: 'When OSS feature flags beat hosted ones'\n2. **Community Engagement Lead** — soft-touch reply in 2 HN threads\n3. **Outbound (deferred — motion not active)**\n\n# Confidence: 0.81\n# Risk tier: P2 (public-facing, comparison framing)\n\n## Evidence\n- [LaunchDarkly pricing page diff](minio://raw/ten_lat_01/competitor_diffs/...)\n- [HN thread](https://news.ycombinator.com/item?id=...)\n- [Reddit r/devops](https://reddit.com/r/devops/...)"
}
```

Same call inserts `signal_events` rows (one per evidence item, `kind=competitor_pricing_change` / `kind=public_reaction`) into ClickHouse via the writer worker, and `signals` rows in Postgres pointing at them. The Signal Router publishes:

```
SUBJECT: gos.signal.routed.v1
PAYLOAD: {
  "signal_id": "sig_LAT_001",
  "kind": "competitor_pricing_change",
  "tenant_id": "ten_lat_01",
  "subscribers": ["agt_LAT_INB_01", "agt_LAT_COM_01"],
  "priority": "P2",
  "deadline": "2026-04-22T17:18:00Z"   // 60min for P2
}
```

7. **Heartbeat finalize** — Paperclip `POST /v1/heartbeat-runs` with the run summary, token cost ($0.07 total), tool calls, output document refs. Issue LAT-1 is checked back in. Activity_log row written to ClickHouse.

**Avery sees nothing yet** — Intel Director's brief is internal until an action agent picks it up.

---

## T+20min — 09:20:00 PT — Inbound Content Strategist wakes on signal

The signal routed at 09:18 wakes `agt_LAT_INB_01` immediately (priority P2, SLA 60min). Same heartbeat lifecycle as above. Differences:

- The agent's checkout creates issue `LAT-2`: *"Action on signal sig_LAT_001 — comparison content"*.
- AGENTS.md additionally contains the opportunity brief (loaded as a referenced Paperclip document) and the agent's playbook (`skills/inbound-content/comparison-post.md`).
- Memory resolver returns: `company/profile.md` (positioning, claims allowlist), 4 prior approved blog posts (none yet — placeholder), tone guide (`skills/inbound-content/voice.md`).

### What the agent does (~4 minutes)

1. Loads `comparison-post.md` skill body (`load_skill('comparison-post')`).
2. Drafts the post in `agents/agt_LAT_INB_01/drafts/2026-04-22_oss-vs-hosted-flags.md` — 1,400 words, 7 H2s, 3 code samples, comparison table.
3. **Claim grounding pass** — every comparative claim ("LaunchDarkly costs $X", "Lattice evaluates in <1ms") is checked against `content_claims` (DB-backed allowlist, populated from n8n discovery signals). Two claims fail (no source) — the agent rewrites them into hedged form.
4. Commits draft to Gitea (`drafts/...md`).
5. Calls Confidence Scorer (`worker-critique`) via NATS request/reply.

### Confidence + self-critique (~30s, ~5k tokens)

`worker-critique` runs a separate LLM call (claude-sonnet-4-6, lower temperature, distinct system prompt — adversarial reviewer):

```
CRITIQUE OUTPUT:
- factual_accuracy: 0.85   (2 claims hedged, 1 source weak — flagged)
- claim_grounding:  0.92
- voice_match:      0.78   (slightly more aggressive than tone guide)
- risk_tier:        P2     (public, comparative — needs human review)
- composite_confidence: 0.76
- recommended_action: human_review_required
- specific_concerns: [
    "Paragraph 4: 'most hosted flag services' is unbounded — soften",
    "CTA wording 'switch today' is more aggressive than approved tone"
  ]
```

Inserted into `confidence_scores` and attached to the issue as a comment:

```bash
POST https://paperclip.gos.internal/v1/issues/LAT-2/comments
{
  "body": "Self-critique: composite 0.76 (P2). Two flags noted; see attached critique doc.",
  "metadata": { "agent_id": "agt_LAT_INB_01" }
}
```

### Approval routing

Composite 0.76 + risk tier P2 + content category `public_publication` → policy says `requires_approval=true, route_to=owner`. Paperclip enqueues an approval:

```bash
POST https://paperclip.gos.internal/v1/approvals
{
  "issueId": "LAT-2",
  "stage": "publish",
  "requestedBy": "agt_LAT_INB_01",
  "reviewers": ["usr_avery"],
  "metadata": { "confidence": 0.76, "risk_tier": "P2" }
}
```

Emits NATS:

```
SUBJECT: gos.approval.requested.v1
PAYLOAD: { "approval_id": "apr_LAT_001", "tenant_id": "ten_lat_01",
           "issue_id": "LAT-2", "user_id": "usr_avery", "tier": "P2" }
```

ws-gateway pushes to Avery's session: an approval card slides into her queue with no animation longer than 120ms.

---

## T+25min — 09:25:00 PT — Avery's approval queue

**What Avery sees:** her dashboard (`/queue`). Single column, three cards. Top card:

```
┌──────────────────────────────────────────────────────────┐
│ Inbound Content Strategist  ·  P2  ·  conf 0.76          │
│ ─────────────────────────────────────────────────────────│
│ Comparison post: When OSS feature flags beat hosted ones │
│ 1,400 words · 4 evidence links · publish to Webflow      │
│                                                           │
│ Self-critique flagged 2 items:                           │
│ • Para 4: "most hosted flag services" unbounded          │
│ • CTA "switch today" more aggressive than tone guide     │
│                                                           │
│ [ Open in editor ]   [ Approve ]   [ Send back ]         │
└──────────────────────────────────────────────────────────┘
```

She opens the editor (TipTap with diff view against the agent's draft). The two flagged paragraphs are highlighted with subtle OKLCH chroma — not red, not alarming, just attention-drawing. She edits ~12% of the copy: softens para 4, replaces "switch today" with "evaluate Lattice alongside your current setup". Word diff lights up live.

She presses **`A`** (keyboard shortcut, cmdk-driven) → approve.

### 09:31:00 — Approval cascade

`POST /v1/approvals/apr_LAT_001/decision`

```json
{ "decision": "approved", "diff": "<patch from editor>", "comment": "" }
```

```sql
-- All in one tx
UPDATE approvals SET status='approved', decided_at=now(), decided_by='usr_avery'
  WHERE id='apr_LAT_001';

INSERT INTO approval_feedback (approval_id, tenant_id, agent_id, decision,
                                edit_distance, edited_sections, latency_ms, decided_at)
VALUES ('apr_LAT_001', 'ten_lat_01', 'agt_LAT_INB_01', 'approved',
        0.12, '["para_4","cta"]'::jsonb, 360000, now());

INSERT INTO event_outbox (subject, payload) VALUES
  ('gos.approval.decided.v1',
   jsonb_build_object('approval_id','apr_LAT_001','decision','approved',
                      'edit_distance',0.12, 'tenant_id','ten_lat_01'));
```

Two consumers:

**Consumer 1 — publication agent** (sub-agent of Inbound Content Strategist). Picks up the edited document and enqueues `n8n.dispatch.requested.v1` with `actionType=publish_content`. n8n runs the Webflow workflow and returns the live URL through execution metadata. GrowthOS inserts an `attribution_touchpoints` row tagged `kind=publication, channel=blog, content_id=...`.

**Consumer 2 — confidence updater**. Updates `confidence_scores` for `agt_LAT_INB_01`: edit_distance 0.12 is within tolerance → small upward bump (+0.03). Updates `motion_scores` for `inbound_content` (+0.01). Both treated as Bayesian updates with informative priors so a single approval moves the needle a little, not a lot.

**What Avery sees at 09:31:** a quiet toast — *"Published to lattice.dev/blog/oss-vs-hosted-flags"* — and the approval card slides out of the queue.

---

## T+1h — 10:18:00 PT — Community Engagement Lead acts on the same signal

`agt_LAT_COM_01` woke at 09:20 alongside the Inbound agent. Its work is faster — 2 HN comments and 1 Discord post. Confidence comes back at **0.83** (lower stakes, well-grounded). Risk tier P3 (public but ephemeral, attribution low). Policy: `requires_approval=false, requires_post_hoc_review=true` (Avery sees it after the fact, can flag).

The agent posts directly. Two HN comment IDs and one Discord message ID written to `attribution_touchpoints`. Avery sees a notification, opens it, gives it a thumbs up — that's `approval_feedback` with `decision=post_hoc_approved` and contributes positively to confidence.

---

## T+3 days — Thursday 09:00 PT — Confidence threshold crossed

By Thursday morning the Inbound Content Strategist has shipped 2 more pieces (one approved with 0.04 edit distance, one approved unchanged). Composite agent confidence has climbed: 0.50 → 0.53 → 0.56 → 0.61 → 0.66.

The Confidence Scorer's hysteresis logic checks whether the agent qualifies for a tier promotion. For `agt_LAT_INB_01`:

- 4 of last 5 approvals had edit_distance < 0.10 ✓
- Zero rejected drafts in last 14 days ✓
- Composite > 0.65 sustained 48h ✓
- No flagged claims ✓

→ Promote from `policy_tier_default=P2` to `P3` for content_category=`comparison_post` only (granular promotion). Future P3-tier comparison drafts will publish without per-piece approval (still post-hoc review). Promotion event:

```
SUBJECT: gos.confidence.tier_promoted.v1
PAYLOAD: { "agent_id":"agt_LAT_INB_01", "from":"P2", "to":"P3",
           "scope":{"content_category":"comparison_post"},
           "evidence_window":"7d" }
```

GrowthBook records this as the start of an **observed-effect window** for the experiment `auto_publish_comparison_posts.v1`. If churn-back to P2 happens within 14 days the promotion is reverted automatically.

**What Avery sees:** a single email Thursday evening — *"Inbound Content Strategist earned auto-publish for comparison posts. You'll still see them in the post-hoc queue. [Review the trust ladder]"*. No popup, no celebration, no animation. Just information.

---

## T+8 days — Tuesday — Learning loop closes

The Learning Director runs nightly (`02:00 PT`, jittered). It scans `approval_feedback` from the last 7 days for patterns. For Lattice:

- 11 approvals total. 9 approved with edit_distance < 0.15. 2 approved with edit_distance > 0.30 — both were CTAs.
- Distillation: *"Avery prefers softer CTAs — 'evaluate alongside' beats 'switch today'. Reword skill voice guide accordingly."*

The Learning Director files a candidate `gtm_learning`:

```sql
INSERT INTO gtm_learnings (tenant_id, kind, source_window, body, status, drafted_at)
VALUES ('ten_lat_01', 'voice_correction', '7d',
        '## Pattern\n\nAcross 11 approvals, the 2 with >30% edits both rewrote the CTA. Owner consistently softens "switch today" → "evaluate alongside".\n\n## Proposed change\n\nUpdate `skills/inbound-content/voice.md` CTA section: replace "switch today" example with "evaluate alongside your current setup".\n\n## Evidence\n- approval apr_LAT_001 (12% edit, CTA rewrite)\n- approval apr_LAT_007 (34% edit, CTA rewrite)\n\n## Confidence: 0.71  ## Risk: P2',
        'pending_approval', now());
```

Files an approval card for Avery (always P2 for skill mutations — learnings can't ship without human consent). Card appears next morning.

She approves. The Learning Director then:

1. Forks the skill: `skills/inbound-content/voice.md` → write a new version, commit to Gitea with message `learning lat-LRN-014: soften CTA defaults`.
2. Increments `playbook_versions.version` for `inbound-content` skill pack.
3. Inserts `experiments` row with `null_hypothesis="softer CTAs do not change approve-without-edit rate"`, allocates 50/50 over the next 14 days (Bayesian — early stop if posterior crosses 0.95).
4. Future heartbeats of `agt_LAT_INB_01` resolve the new skill version (skills resolver always loads `latest_active`).

**Avery sees:** the approval card, then nothing more — until 14 days later when the experiment closes with a posterior of 0.91 in favor of the softer voice. A single weekly-review bullet: *"Voice change validated: approve-without-edit rate 64% → 78% on comparison posts (n=18)."*

---

## What this trace proves about the architecture

| Concern | How this trace honored it |
|---|---|
| **Async by default** | Every cross-component handoff went through NATS. The only sync calls were tenant provisioning (single-tx, <2s) and user-initiated reads. |
| **Stateless services** | Every worker (heartbeat, signal-router, critique, learning) reads its full context from Paperclip + Gitea + Postgres + Qdrant on each invocation. No in-process state. Restart-safe. |
| **Idempotency** | Every NATS handler keyed on `signal_id` / `approval_id` / `heartbeat_id`. Duplicate deliveries no-op. Outbox pattern guarantees Postgres↔NATS consistency. |
| **Backpressure as demotion** | If the LLM router or n8n dispatch boundary is saturated, low-priority heartbeats (P3/P4) are deferred up to 60min; P0 signals always preempt. GrowthOS records retry metadata instead of silently queueing. |
| **Tenant isolation** | Every SQL query in this trace is RLS-scoped on `company_id`. Gitea repo is per-tenant. Qdrant collection is per-tenant. NATS subjects are filtered by JetStream consumer with `subject_filter=gos.*.{tenant_id}.*` for tenant-scoped events. |
| **Harness anatomy** | Filesystem (Gitea), connector fabric (n8n), sandbox (Daytona on demand), memory + search (Qdrant + AGENTS.md regen), context-rot mitigation (skills as progressive disclosure, artifact references), Ralph loop (heartbeat hook), planning + self-verification (plan.md + worker-critique). |
| **Replayability** | Every action references its triggering signal_id and the Gitea SHA of the agent-fs at run time. Any heartbeat can be replayed against the same inputs to reproduce its output. |
| **Confidence as economics** | Tier promotion is automatic but reversible. Approval friction decays as trust is earned. The owner's edit_distance is the canonical learning signal. |
| **Cost discipline** | Discovery sweep ~$0.07. First Inbound heartbeat ~$0.07. First Community heartbeat ~$0.03. Per-tenant first-day spend $0.30, week-one ~$3.20 — well under the $275 monthly budget ceiling. |
| **Founder UX** | Avery interacted with the system 3 times in 8 days: once to confirm motions, once to approve a draft, once to approve a learning. Total active time: ~8 minutes. |

---

## Failure modes this trace doesn't cover (next walkthrough)

- **Signal storm** — 200 signals in 5 minutes; how the Signal Router rate-limits per agent and merges duplicates.
- **Hallucinated claim slips approval** — what the post-hoc claim auditor (runs nightly against `attribution_touchpoints` + `content_claims`) catches and how it triggers a retraction workflow.
- **Confidence decay** — 3 consecutive rejections; the demotion path back from P3→P2.
- **Cross-tenant noisy neighbor** — one tenant burns through their LLM or n8n dispatch budget; how GrowthOS rate limiting + n8n workflow isolation contains the blast radius.
- **Paperclip outage** — degraded-mode where heartbeats queue locally in NATS for up to 30 min and replay on recovery.
- **Schema migration** — adding a column to `signals` without taking writes offline (Atlas + pgroll expand-contract).

These will be appendices to this document as we implement them in Phase 2/3.

---

## Reading order for new engineers joining the project

1. `Growthos_v4.md` — the strategic spec (what we're building)
2. `anatomy_of_agentic_harness.md` — the mental model (why agents need a harness)
3. `paperclip_guide.md` — the control plane (the company runner we fork from)
4. `Growthos_v4_Stack_Decisions.md` — the tooling rationale
5. `Growthos_v4_Technical_Architecture.md` — the system blueprint
6. `Growthos_v4_Implementation_Plan.md` — the build order
7. **This document** — the end-to-end ground truth
