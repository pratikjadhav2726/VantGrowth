
# GrowthOS — Architecture Specification v4
**Motion-First Startup Operating System for GTM, Revenue, and Growth Execution**  
**Status:** Strategic architecture spec  
**Audience:** Founder, product architect, AI systems engineer, GTM operator  
**Positioning:** Approval-gated, self-improving startup operating system that compresses early GTM, RevOps, lifecycle, and growth work into one governed platform.

---

## 0. Executive Summary

GrowthOS should not be pitched as a magical AI company that fully replaces human judgment across sales, marketing, customer success, and operations. It should be built as a **startup operating system** that:

1. Diagnoses the right GTM motions for a startup.
2. Executes narrow, high-leverage workflows with human oversight where risk is high.
3. Learns from outcomes, edits, experiments, and stage transitions.
4. Compounds into a founder-specific GTM playbook over time.

The core design principle is simple:

> **Automate repeatable GTM work, not strategic accountability.**

That means GrowthOS should aim to **compress 6–10 early hires**, not pretend to eliminate the need for founder judgment, customer empathy, deal-making, or category intuition.

---

## 1. Brutal Thesis

### 1.1 What GrowthOS should be
- A **motion-first GTM and revenue operating system** for technical B2B startups.
- A **control plane for growth execution**, not just a content generator.
- A **trust-building system** that shows why it recommended an action, what evidence it used, and what changed in the playbook.
- A **durable workflow engine** with strong approvals, audit, retries, memory, and policy enforcement.
- A **founder-specific learning system** that compounds from real outcomes.
- A **RevOps-aware system** that spans acquisition, activation, expansion, and reporting.
- A **workflow + policy + memory product**, not merely a multi-agent chat product.
- A **human-supervised system for risky external actions**.
- A **startup stage-aware system** that changes recommendations as the company evolves.
- A **measurement-first product** where each action maps to a metric and lifecycle stage.

### 1.2 What GrowthOS should not be
- Not a generic swarm of agents with vague roles.
- Not a “replace your whole company overnight” fantasy.
- Not a content mill.
- Not a cold-email cannon.
- Not an agent wrapper around disconnected SaaS tools.
- Not a system that updates ICP, messaging, or outbound behavior without constraints.
- Not a pure orchestration demo.
- Not a workflow engine without learning.
- Not a learning engine without guardrails.
- Not a product that hides its reasoning behind “AI magic.”

### 1.3 What can realistically be automated in 2026
**High automation potential**
- market and competitor monitoring
- signal detection and triage
- draft generation
- structured personalization prep
- campaign operations
- CRM hygiene and routing
- experiment creation and evaluation
- lifecycle messaging generation
- reporting and weekly operating reviews
- approval queue preparation
- playbook maintenance
- onboarding content and help assets
- lead scoring and routing
- content repurposing
- low-risk community/support replies with approval or strict policy

**Partial automation only**
- positioning refinement
- outbound sequencing strategy
- partner targeting
- account prioritization
- onboarding strategy
- customer expansion recommendations
- pricing-page and packaging insight generation
- narrative support for fundraising or launches

**Human-owned**
- final positioning calls
- founder brand voice / public stance
- enterprise sales conversations
- negotiations
- partner relationship building
- sensitive public/community interactions
- customer escalation handling
- strategy resets during major pivots
- investor relationship management
- hiring and org design decisions

### 1.4 Where people overestimate agents in GTM
- assuming agents can infer positioning from noisy data
- assuming generated content equals demand generation
- assuming outbound is mostly about writing emails
- assuming experiments produce causal truth automatically
- assuming “more agents” means more capability
- assuming orchestration is the moat
- assuming approval queues alone create trust
- assuming attribution can be solved cheaply
- assuming founders will tolerate black-box automation on public channels
- assuming one GTM system works for all startup shapes

---

## 2. End-to-End Startup Operating Map

GrowthOS should treat startup growth as one connected operating loop:

**research → strategy → positioning → launch → acquisition → activation → conversion → retention → expansion → reporting → replanning**

### 2.1 Lifecycle table

| Stage | Objective | Inputs | Outputs | Core Metrics | Human-in-loop | Common Failure Modes |
|---|---|---|---|---|---|---|
| Research | Understand market, buyers, alternatives, signals | website, calls, CRM notes, competitors, communities, search, product usage | ICP hypotheses, pain map, competitor map, market events | signal volume, source quality, insight freshness | review for strategic shifts | noisy data, stale sources, wrong segmentation |
| Strategy | Choose motions and priorities | research outputs, constraints, budget, ACV, cycle length | motion stack, quarterly priorities, budget envelope | motion fit score, confidence, resource allocation | founder approval required | one-size-fits-all motion choice |
| Positioning | Clarify who it is for and why it wins | ICP, competitor map, call notes, win/loss, product facts | messaging matrix, claims library, proof points, do-not-say rules | win rate by segment, message adoption | mandatory founder approval | drift, hallucinated claims, generic language |
| Launch | Package narrative and channel plan | positioning, product updates, launch goals | launch brief, content plan, channel plan, enablement assets | launch reach, engagement, signups | founder plus PMM review | disconnected launch assets |
| Acquisition | Generate qualified awareness and pipeline | motion stack, channel policies, content, prospect lists | content, campaigns, outbound touches, community replies, partner outreach | qualified sessions, reply rate, meetings, sourced pipeline | approval for risky sends/posts | spam, weak personalization, wrong channels |
| Activation | Convert interest into first value | product signals, lifecycle stage, docs usage, onboarding events | onboarding nudges, help sequences, setup guidance | activation rate, time-to-value | mostly policy-driven; review edge cases | messages not tied to product behavior |
| Conversion | Move activated users/leads into revenue motion | lead/account state, pricing page behavior, deal stage, product usage | follow-ups, AE assist briefs, conversion plays | opp creation, trial-to-paid, meeting-to-close | human-led on high-value deals | bad attribution, premature sales push |
| Retention | Sustain adoption and reduce churn risk | support events, usage trends, CS notes, sentiment, roadmap | health signals, save plays, education nudges | retention, logo churn, usage depth | human review for risk accounts | false health scores |
| Expansion | Find and execute growth inside accounts | usage breadth, stakeholder map, product limits | expansion recommendations, champion enablement, upsell briefs | expansion pipeline, seat growth, NRR | human ownership on commercial actions | over-automated upsell, poor timing |
| Reporting | Explain what worked and why | all performance and lifecycle data | weekly review, motion health, bottlenecks, budget usage | conversion, velocity, CAC proxies, ROI | founder review | vanity metrics, poor baselines |
| Replanning | Update priorities and playbooks | reporting, learnings, stage changes, motion performance | new motion weights, budget shifts, skill updates | improvement vs baseline, confidence in changes | founder approval for major changes | overreacting to short-term noise |

---

## 3. Team Replacement Matrix

| Function | Replace / Compress / Assist | Automation today | Deterministic work | Agentic work | Human mandatory |
|---|---|---:|---|---|---|
| Product Marketing | Compress | 35–50% | asset production, research packaging, launch checklisting | message hypothesis generation, competitor interpretation | final positioning, launch narrative, claims |
| Demand Gen | Compress | 45–65% | scheduling, routing, reporting, repurposing | channel mix recommendations, content variant generation | budget allocation, strategic campaign calls |
| SDR / Outbound | Compress | 40–60% | enrichment, routing, follow-up tasks, logging | personalization, sequence adaptation, warm outbound prep | live selling judgment, sensitive outreach |
| AE / Founder Sales Assist | Assist | 15–30% | call prep, summaries, next-step drafting | objection clustering, tailored collateral | discovery, negotiation, deal strategy |
| RevOps | Compress | 50–70% | hygiene, stage updates, dedupe, routing, dashboards | leak detection, workflow recommendations | system design, compensation, governance |
| Customer Success | Compress | 25–45% | onboarding prompts, health monitoring, QBR draft prep | expansion suggestions, churn-risk synthesis | escalations, renewals, strategic account recovery |
| Growth Ops | Compress | 50–70% | experiment setup, tracking, alerting | experiment generation, growth hypothesis ranking | final prioritization |
| Partnerships | Assist | 20–35% | research, mapping, brief generation | partner fit assessment, co-marketing ideas | relationship building and deal terms |
| Community | Compress | 25–40% | monitoring, triage, draft prep | response generation, topic mining | tone-sensitive public interactions |
| Content / SEO / GEO | Compress | 55–75% | drafting, repurposing, formatting, schema generation | angle selection, AI-answer optimization, varianting | editorial judgment, public thought leadership |

**Conclusion:** GrowthOS can **compress** early teams significantly, but only **assist** human-owned strategic and relationship-heavy functions.

---

## 4. Product Scope and ICP

### 4.1 Best v1 ICP
GrowthOS v1 should target:

- **Founder stage:** post-PMF-ish early traction, not true zero-to-one idea stage
- **Company size:** 2–15 employees
- **Product type:** B2B SaaS, AI SaaS, developer tools, infra tools, technical workflow products
- **ACV:** roughly $3k–$30k
- **Sales cycle:** 2–12 weeks
- **Buyer:** technical operator, engineering manager, PM, ops lead, GTM operator, founder
- **Channel environment:** content + community + warm outbound + lifecycle + partner-adjacent
- **Data maturity:** basic CRM, analytics, website, product events, founder content or call notes

### 4.2 Why this is the wedge
This ICP:
- tolerates some automation if it is transparent
- already lives in digital channels
- benefits from content + community + warm outbound + product-led assists
- often lacks full PMM, RevOps, demand gen, and CS headcount
- has enough data to support learning loops
- is not so enterprise-heavy that human process dominates everything

### 4.3 ICPs to avoid in v1
- enterprise-only sales-led companies with 6–18 month cycles
- consumer/mobile mass-market products
- heavily regulated outbound-first businesses
- agencies and service businesses
- hardware/field-sales businesses
- very low-data startups without CRM, analytics, or product events
- true pre-product or pre-message startups

---

## 5. Motion-First Architecture

### 5.1 Core principle
GrowthOS should never deploy a fixed GTM machine.
It must first score motions, then instantiate a motion stack and corresponding capabilities.

### 5.2 Supported motions
- Inbound
- Outbound
- Community
- PLG
- ABM
- Partners
- Paid

### 5.3 Add one missing motion
Add **Lifecycle / Expansion** as a first-class motion.  
Why: many startups leak growth after acquisition because onboarding, adoption, retention, and expansion are handled as afterthoughts. Lifecycle is not merely a downstream workflow; it is a growth motion.

### 5.4 Motion scoring dimensions
Each motion gets a weighted score based on:

- product complexity
- trialability / self-serve readiness
- ACV
- sales cycle length
- buyer concentration
- identifiable account list quality
- founder content capacity
- category search demand
- community density
- partner ecosystem richness
- budget availability
- signal richness
- product telemetry availability
- compliance risk
- founder willingness to approve public/external actions

### 5.5 Example scoring output
```json
{
  "founder_id": "f_123",
  "scored_at": "2026-04-22T10:00:00Z",
  "scores": {
    "inbound": 8.8,
    "community": 8.1,
    "outbound": 6.7,
    "plg": 5.4,
    "abm": 6.2,
    "partners": 7.0,
    "paid": 3.9,
    "lifecycle_expansion": 7.4
  },
  "selected_stack": {
    "primary": ["inbound", "community"],
    "secondary": ["partners", "lifecycle_expansion"]
  },
  "deactivated": ["paid", "plg"],
  "rationale": [
    "strong technical category with searchable pain",
    "community density exists",
    "budget constrained; paid is not justified",
    "product telemetry is moderate but enough for lifecycle assists"
  ]
}
```

### 5.6 Re-scoring cadence
- onboarding
- 30 days after onboarding
- quarterly
- after major pricing change
- after major ICP shift
- after significant product packaging change
- after sustained motion underperformance
- after founder override on strategic recommendations

### 5.7 Activation / deactivation rules
- activate a motion if score is above threshold and necessary systems are connected
- deactivate if ROI falls below floor for two consecutive review windows
- hold in “observe-only” mode if signal is promising but evidence is weak
- never auto-activate high-risk motions without founder confirmation

---

## 6. Harness Architecture

### 6.1 Design principle
Use **deterministic workflows by default** and **agentic reasoning only where ambiguity is valuable**.

### 6.2 Layered architecture

```text
┌──────────────────────────────────────────────────────────────────┐
│ Founder Surfaces                                                 │
│ Onboarding · Motion scoring UI · Approvals · Review · Dashboard │
│ Weekly operating review · Experiment view · Playbook diff       │
└──────────────────────────────┬───────────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────────┐
│ Control Plane / Orchestrator                                     │
│ Goal model · motion stack · agent roster · workflow state        │
│ schedules · issues/tasks · approvals · budgets · tracing         │
└───────────────┬───────────────────────┬──────────────────────────┘
                │                       │
┌───────────────▼──────────────┐  ┌────▼───────────────────────────┐
│ Domain Services               │  │ Policy / Risk Services         │
│ motion engine                 │  │ approval policy                │
│ signal router                 │  │ compliance policy              │
│ confidence scorer             │  │ action-tiering                 │
│ experiment manager            │  │ do-not-send / do-not-learn     │
│ attribution engine            │  │ tenant isolation checks        │
│ lifecycle engine              │  │ content and claim validation   │
└───────────────┬──────────────┘  └───────────────┬────────────────┘
                │                                 │
┌───────────────▼─────────────────────────────────▼───────────────┐
│ Memory + Systems of Record                                       │
│ structured memory · CRM mirror indices · content performance     │
│ experiments · approvals · audit metadata · lifecycle state       │
└───────────────┬──────────────────────────────────────────────────┘
                │
┌───────────────▼──────────────────────────────────────────────────┐
│ Tool Gateway / MCP Layer                                         │
│ governed tools · entitlements · quotas · session audit           │
│ search · CRM · CMS · analytics · email · social · product data   │
└───────────────┬──────────────────────────────────────────────────┘
                │
┌───────────────▼──────────────────────────────────────────────────┐
│ External Systems                                                  │
│ CRM · website · analytics · product events · email · communities │
│ ads · support · docs · search APIs · partner systems             │
└──────────────────────────────────────────────────────────────────┘
```

### 6.3 What belongs where

#### Control plane / orchestrator
- motion stack
- company goals
- agent roster
- task state machine
- human approval gates
- issue / event lifecycle
- retries, dedupe, durable execution checkpoints
- tracing and run metadata

#### Domain services
- motion scoring
- confidence scoring
- learning evaluation
- experiment engine
- attribution logic
- lifecycle-stage logic
- signal classification
- budget allocator

#### Memory layer
- typed learnings
- performance history
- experiment history
- approvals + edits
- founder preferences
- playbook versions
- ICP / messaging snapshots
- segment-level outcomes

#### Tool gateway / MCP
- governed access to tools
- entitlement checking
- session isolation
- rate limits
- audit trail
- schema validation for tool calls
- content filters and policy execution

#### Channel surfaces
- founder UI
- email / notifications
- content publishing channels
- CRM tasks
- internal ops review

### 6.4 When to use workflows vs agents
**Use workflows when**
- steps are known in advance
- compliance matters
- reproducibility matters
- actions are frequent and templated
- failure recovery must be crisp

**Use agents when**
- interpretation is needed
- synthesis across noisy signals matters
- personalization requires contextual reasoning
- recommendations need ranking under uncertainty

### 6.5 When to use heartbeats vs event triggers
**Heartbeats**
- daily intel sweeps
- weekly reporting
- scheduled lifecycle reviews
- periodic motion re-scoring
- periodic model/risk audits

**Event triggers**
- prospect replied
- high-intent session
- free user hit paywall / limit
- competitor pricing changed
- brand mention in important thread
- experiment reached sample threshold
- founder rejected or heavily edited output
- churn-risk threshold breached

### 6.6 Handoffs
All handoffs must be structured, not prose-only.

Example:
```json
{
  "handoff_type": "content_brief.v1",
  "founder_id": "f_123",
  "motion": "inbound",
  "topic": "deployment governance for MCP tools",
  "audience": ["engineering manager", "platform lead"],
  "pain_points": [
    "tool sprawl",
    "missing audit trail",
    "token waste from large tool outputs"
  ],
  "proof_points": [
    "customer quote available",
    "demo clip available",
    "benchmark result available"
  ],
  "risk_flags": ["claim_verification_required"],
  "target_metric": "qualified organic signups"
}
```

### 6.7 Durable execution requirements
- checkpoint at each node boundary
- idempotency key for every external action
- retry policy per tool category
- dead-letter queue for failed actions
- manual replay with approval
- rollback only for reversible internal state, not external sends
- compensation tasks for partial failure

### 6.8 State machine for risky external action
```text
drafted
  → confidence_scored
  → policy_checked
  → approval_required
      → approved → dispatched → confirmed → measured
      → rejected → revised
      → expired
```

---

## 7. Agent and System Design

### 7.1 What should NOT be agents
These should be backend services, not LLM agents:
- scheduler
- signal ingestion connectors
- experiment evaluator
- attribution aggregator
- risk engine
- policy engine
- idempotency / retry manager
- cache layer
- partition manager
- billing enforcement
- metrics aggregation
- lifecycle stage calculator
- approval routing engine

### 7.2 V1 agent roster
V1 should stay tight.

#### Always-present
1. **Intel Director**
2. **Learning Director**
3. **Reporting Director**

#### Motion-specific pool (activated from motion stack)
4. **Inbound Content Strategist**
5. **Community Operator**
6. **Warm Outbound Researcher**
7. **Lifecycle Operator**
8. **Partner Scout**

### 7.3 V2 expansion pool
9. **ABM Planner**
10. **Customer Expansion Analyst**
11. **GEO Monitor**
12. **Launch Orchestrator**
13. **Revenue Leak Investigator**
14. **Founder Narrative Assistant**

### 7.4 Detailed agent specs

#### Intel Director
- **Mission:** maintain current picture of ICP, competitors, pain signals, message opportunities
- **Triggers:** daily + major market signals
- **Inputs:** research sources, CRM notes, win/loss, product notes, communities
- **Outputs:** ICP deltas, competitor deltas, signal summaries, recommendation candidates
- **Tools:** search, social listening, CRM read, web watch, memory read/write
- **Reads/Writes:** reads current ICP and learnings; writes signal summaries and market updates
- **Approval:** strategic ICP changes require founder approval
- **Budget logic:** capped daily spend, higher budget after meaningful change events
- **Failure modes:** overreacting to noisy competitors, bad segmentation, stale signals
- **Success metrics:** usefulness of briefs, downstream conversion lift, founder acceptance rate

#### Learning Director
- **Mission:** turn outcomes, edits, experiments, and failures into controlled playbook updates
- **Triggers:** action complete events + weekly learning review
- **Inputs:** performance data, experiments, approvals, edits, lifecycle outcomes
- **Outputs:** learnings, proposed playbook changes, confidence updates, avoid-lists
- **Tools:** memory read/write, performance read, experiment read, approval history read
- **Reads/Writes:** writes structured learnings; marks TTL and revalidation dates
- **Approval:** playbook and policy updates above threshold require approval
- **Budget logic:** event-light, weekly-heavy
- **Failure modes:** false causality, poisoned learning, premature generalization
- **Success metrics:** accepted learning rate, sustained performance lift, low reversal rate

#### Reporting Director
- **Mission:** create weekly operating review and explain what matters
- **Triggers:** weekly
- **Inputs:** performance, pipeline, product activation, learnings, motion health
- **Outputs:** weekly review, bottlenecks, next-best actions, budget summary
- **Approval:** no approval needed for internal report
- **Failure modes:** vanity metrics, misleading attribution
- **Success metrics:** founder usefulness rating, action adoption rate

#### Inbound Content Strategist
- **Mission:** produce content assets mapped to motion goals and proof points
- **Triggers:** scheduled content plan + launch events + intel briefs
- **Inputs:** topic briefs, brand rules, messaging, proof points, experiments
- **Outputs:** blogs, pages, emails, social derivatives, schema-ready assets
- **Tools:** CMS draft, search, citation checks, analytics read
- **Approval:** publish approval required unless auto-approve unlocked
- **Failure modes:** generic copy, unverified claims, poor GEO format
- **Success metrics:** qualified traffic, assisted conversions, founder edit rate

#### Community Operator
- **Mission:** monitor communities, draft thoughtful replies, surface opportunities
- **Triggers:** thread/event signals, scheduled sweeps
- **Inputs:** thread context, community norms, founder voice, message guardrails
- **Outputs:** reply drafts, opportunity reports, pain-language updates
- **Tools:** community read/post, memory read/write
- **Approval:** public posting approval by default
- **Failure modes:** spammy tone, self-promotion, norm violations
- **Success metrics:** response quality, traffic assists, community-derived signups

#### Warm Outbound Researcher
- **Mission:** research targets and prepare warm outbound paths
- **Triggers:** motion active + account queue + warm signals
- **Inputs:** account list, role signals, funding/job changes, content interactions
- **Outputs:** target dossiers, personalization facts, suggested sequence steps
- **Tools:** CRM, web research, LinkedIn-like signals where permitted
- **Approval:** external actions require approval; research does not
- **Failure modes:** bad targeting, outdated signals, fake personalization
- **Success metrics:** reply rate lift, meeting rate, founder acceptance

#### Lifecycle Operator
- **Mission:** improve activation, onboarding, retention, and light expansion nudges
- **Triggers:** product events, lifecycle transitions, risk signals
- **Inputs:** usage events, docs visits, feature gates, support data
- **Outputs:** lifecycle prompts, save-play drafts, activation nudges, expansion recommendations
- **Tools:** analytics, product event tools, email, in-app messaging, support read
- **Approval:** low-risk internal/on-product messaging may be policy-approved; external sensitive sequences require review
- **Failure modes:** mistimed nudges, poor health scoring, over-automation
- **Success metrics:** activation lift, time-to-value, retention, expansion assists

#### Partner Scout
- **Mission:** identify partnership opportunities and co-marketing fits
- **Triggers:** weekly + ecosystem changes + founder request
- **Inputs:** product map, integrations, market adjacency, partner lists
- **Outputs:** ranked partner list, outreach briefs, co-marketing ideas
- **Approval:** outreach approval required
- **Failure modes:** low-fit partnerships, weak economics
- **Success metrics:** accepted partner targets, meetings, sourced opportunities

---

## 8. Learning System

### 8.1 Design goals
The learning system must:
- improve behavior
- avoid poisoning
- distinguish local founder truth from global heuristics
- decay stale learnings
- preserve auditability
- remain reversible

### 8.2 Typed memory schema (core tables)
```sql
CREATE TABLE gtm_learnings (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('founder', 'segment', 'global')),
  motion TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  pattern_type TEXT NOT NULL,
  description TEXT NOT NULL,
  evidence_count INT NOT NULL,
  confidence NUMERIC(4,3) NOT NULL,
  impact_metric TEXT NOT NULL,
  impact_delta NUMERIC(8,4),
  ttl_days INT NOT NULL DEFAULT 90,
  learned_from TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('candidate', 'active', 'expired', 'rejected', 'superseded')),
  created_at TIMESTAMPTZ NOT NULL,
  last_validated_at TIMESTAMPTZ,
  supersedes_id UUID
);

CREATE TABLE approval_feedback (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  output_id UUID NOT NULL,
  output_type TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('approved', 'edited_then_approved', 'rejected')),
  edit_distance NUMERIC(6,4),
  rubric_failures TEXT[] NOT NULL DEFAULT '{}',
  reviewer_note TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE experiments (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  motion TEXT NOT NULL,
  experiment_type TEXT NOT NULL,
  unit_type TEXT NOT NULL,
  variant_a JSONB NOT NULL,
  variant_b JSONB NOT NULL,
  metric_name TEXT NOT NULL,
  min_sample_size INT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'concluded', 'abandoned', 'promoted')),
  winner TEXT CHECK (winner IN ('a', 'b', 'inconclusive')),
  confidence NUMERIC(4,3),
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ
);

CREATE TABLE playbook_versions (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  motion TEXT NOT NULL,
  artifact_type TEXT NOT NULL CHECK (artifact_type IN ('skills', 'policy', 'workflow', 'messaging')),
  content JSONB NOT NULL,
  version INT NOT NULL,
  change_reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
```

### 8.3 Learning sources
- experiment outcomes
- approvals and edits
- lifecycle conversion results
- content performance
- outbound performance
- community performance
- support and activation outcomes
- founder overrides
- negative incidents and policy blocks

### 8.4 Learning rules
- never write a high-confidence learning from one event
- require min evidence + baseline comparison
- tag every learning with source category
- exclude anomalous windows from learning
- revalidate active learnings on cadence
- expire learnings automatically if not revalidated
- maintain an explicit avoid-list for failed patterns

### 8.5 Confidence scoring
Confidence is used for:
- queue routing
- risk review intensity
- auto-approve eligibility
- learning eligibility
- policy override prevention

Output score should combine:
- structural checks
- policy checks
- recency of evidence
- fit to ICP / target
- brand alignment
- specificity
- novelty vs known-losing patterns
- factuality or proof availability
- channel appropriateness

### 8.6 What a learning changes
A learning can modify:
- prompt/skill content
- workflow choice
- channel routing
- confidence thresholds
- playbook defaults
- avoid-lists
- budget allocation
- audience segmentation
- send-time / sequence logic

It should **not** directly change:
- legal/compliance rules
- high-risk approval requirements
- tenant isolation policy
- hard claims library without approval

### 8.7 Global cross-founder learnings
Global learnings must be:
- aggregated
- anonymized
- segment-scoped
- never expose tenant-specific text or metrics directly
- opt-out capable
- used as priors, not tenant truth

Example:
```json
{
  "scope": "segment",
  "segment": "B2B devtools, ACV 5k-20k, 2-8 week sales cycle",
  "pattern_type": "content_format",
  "description": "comparison-driven content outperforms abstract thought leadership on assisted demo creation",
  "confidence": 0.78,
  "evidence_count": 143
}
```

---

## 9. Data and Systems of Record

### 9.1 Canonical sources of truth
| Domain | System of record |
|---|---|
| CRM entities, deals, lifecycle ownership | CRM |
| Contact/account enrichment cache | GTM mirror / enrichment store |
| Activity history (agent actions) | orchestrator audit log + immutable action ledger |
| Campaign state | GTM backend campaign service |
| Content performance | analytics/performance store |
| Experiment state | experiment service |
| Learning memory | structured memory store |
| Approvals and edits | approval service |
| Founder settings and policies | GTM config store |
| Billing and plan state | billing service |
| Tool execution logs | MCP gateway audit |
| Attribution models | GTM attribution service |

### 9.2 Avoiding split-brain state
Rules:
1. Every domain has one canonical owner.
2. Other systems keep indexed or derived copies only.
3. All state changes emit events with version numbers.
4. External actions store idempotency keys.
5. Approval decisions are first-class events, not UI-only data.
6. Playbook updates are versioned artifacts, never silent mutations.

### 9.3 Event taxonomy
```text
motion.stack.selected
agent.task.created
agent.output.generated
output.confidence.scored
output.policy.checked
output.approval.requested
output.approved
output.rejected
action.dispatched
action.confirmed
performance.observed
experiment.started
experiment.concluded
learning.candidate.created
learning.activated
playbook.updated
risk.blocked
lifecycle.stage.changed
```

---

## 10. Risk, Trust, and Compliance

### 10.1 Policy tiers
| Tier | Example | Approval | Notes |
|---|---|---|---|
| P0 Low risk | internal summary, draft brief | none | internal only |
| P1 Moderate | draft blog, newsletter draft, CRM updates | optional / queue | channel safe, reversible |
| P2 Public | community reply, social post, website publish | approval required initially | brand-sensitive |
| P3 Commercial | outbound email, partner outreach, expansion message | approval required | revenue + compliance risk |
| P4 Sensitive | pricing claims, legal wording, investor materials, escalations | explicit human ownership | AI assist only |

### 10.2 Key guardrails
- human approval for P2–P4 by default
- claims library with verification status
- policy engine for send/post eligibility
- do-not-learn filters
- rate limits per channel
- tenant-scoped secrets and tool entitlements
- anomaly alerts for action spikes
- content provenance and source references internally
- community norms per platform
- suppression lists and consent logic
- deliverability health monitoring
- ICP version approval for large strategic changes

---

## 11. Product and UX Design

### 11.1 UX principles
- show evidence, not magic
- show what changed, not just what happened
- show confidence and risk clearly
- ask for intervention only when the founder adds unique value
- explain playbook evolution over time

### 11.2 Core founder surfaces

#### Onboarding
- company basics
- product and market intake
- signal/data source connection
- motion scoring review
- initial policy preferences
- brand / claims review

#### Motion scoring UI
- motion scores
- why each motion scored that way
- what data sources influenced the score
- what motions are active / dormant / blocked
- what would need to change to activate another motion

#### Approval queue
For each item show:
- confidence score
- risk tier
- source evidence
- what experiment variant it belongs to
- why it was generated now
- diff view after edits
- learn/not-learn toggle for founder

#### Experiment dashboard
- running experiments
- winning variants
- evidence counts
- confidence in winner
- effect by segment
- experiments waiting for more data

#### Weekly operating review
- motion health
- key bottlenecks
- pipeline and activation summary
- changes to playbook
- proposed next week priorities
- where founder action is needed

### 11.3 UX anti-patterns to avoid
- agent chat as the main interface
- hidden policy decisions
- unclear reasons for recommendations
- mixing drafts and risky actions in one list
- no visibility into why an auto-approved action was allowed

---

## 12. Economics

### 12.1 Cost drivers
**Infra**
- orchestration runtime
- memory store
- queueing
- analytics ingestion
- audit logging

**LLM**
- content generation
- personalization
- self-critique
- learning synthesis
- approval explanations

**Third-party data/providers**
- search / SERP / GEO checks
- CRM enrichment
- analytics connectors
- social/community data
- email infrastructure

**Human review**
- founder approval time
- support time for bad automations
- content review burden

### 12.2 Best ROI zones
Highest ROI in v1:
- signal triage
- content repurposing
- structured outbound prep
- lifecycle nudges
- reporting and experiment management
- playbook memory and reuse

Lower ROI early:
- full paid campaign automation
- enterprise AE replacement
- fully automated public community activity
- investor narrative automation

### 12.3 Pricing metric customers will value
Avoid pricing on “agents” or raw “tool calls” as the main headline metric.
Lead with outcome-shaped value:
- active motions
- approved actions per month
- tracked accounts/leads/users
- connected systems
- learning / experiment depth
- lifecycle coverage
- seats / workspaces for later plans

---

## 13. Competitive Wedge and Moat

### 13.1 Commodity layers
- base orchestration
- raw prompt generation
- generic multi-agent chat
- basic content drafting
- tool calling alone
- standard dashboards

### 13.2 Defensible layers
- motion engine with lifecycle-aware scoring
- founder-specific playbook evolution
- approval + edit telemetry turned into learning
- GTM-specific workflow and policy design
- strong trust UX
- cross-functional lifecycle coverage from acquisition to expansion
- segment-level benchmark and learning priors
- high-quality handoff contracts and domain schemas
- governed execution tied to measurable outcomes

### 13.3 True moat thesis
The moat is not “we use agents.”
The moat is:

> **a founder-specific, evidence-backed startup operating playbook that compounds across motions and lifecycle stages, executed through trusted workflows and governed tooling.**

---

## 14. Twenty Likely Bad Ideas

| Bad idea | Why tempting | Why it fails | What to do instead |
|---|---|---|---|
| generic agent swarm | sounds powerful | no accountability, high noise | motion-specific roster |
| full autonomy at launch | demo-friendly | destroys trust | approval-gated rollout |
| all channels at once | looks comprehensive | weak signal, high complexity | start with 2–3 motions |
| pricing on agent count | easy to sell internally | customer doesn’t care | price on value surfaces |
| chat-first UI | trendy | poor operations UX | queue + dashboard + review |
| content-first GTM | easy to show | not enough pipeline | connect to lifecycle and reporting |
| cold outbound default | faster top-of-funnel | low quality, compliance risk | warm outbound by default |
| no explicit claims library | saves setup time | hallucinated messaging | verified claims registry |
| learning from every action | maximum data | poisoned memory | do-not-learn filters |
| no TTL on learnings | simpler | fossilized playbook | expiry + revalidation |
| no founder edit capture | easier implementation | lose best feedback | structured approval telemetry |
| mix policy and prompts | quick hack | brittle and unsafe | separate policy layer |
| no canonical SOR rules | faster build | split-brain state | assign owner per domain |
| use agents for scheduling | “everything AI” | wasteful and unreliable | deterministic services |
| over-index on SEO only | familiar | misses GEO/lifecycle | combine inbound + GEO + lifecycle |
| assume attribution is solved | dashboard looks clean | bad decisions | explicit confidence and caveats |
| too many motion activations | feels intelligent | diffused focus | thresholded motion stack |
| no risk tiers | simpler UI | wrong approval burden | policy tiers |
| replace founder voice | scalable content | loses authenticity | AI drafts, founder-owned public voice |
| ignore CS/retention | acquisition looks sexy | leaky bucket | lifecycle motion included |

---

## 15. Final Recommendation

### 15.1 Best v1 product
A **motion-first growth operating system for technical B2B startups** that:
- scores motions
- runs inbound + community + warm outbound or lifecycle depending on fit
- drafts and routes high-leverage actions
- requires approval for risky public/commercial actions
- learns from outcomes and edits
- gives weekly operating reviews with playbook evolution

### 15.2 Best v2 expansion path
Add:
- ABM
- richer lifecycle and expansion orchestration
- partner co-selling/co-marketing
- segment benchmark priors
- deeper RevOps leak detection
- launch orchestration
- multi-user workspace and role-based approvals

### 15.3 Minimum lovable architecture
- orchestrator with durable tasks, approvals, tracing
- motion scoring engine
- structured memory store
- experiment engine
- confidence scorer
- signal router
- 4–5 high-value agents
- governed tool gateway
- founder dashboard with approvals and weekly review

### 15.4 Biggest technical risk
**Split-brain state and low-trust learning loops.**  
If approvals, experiments, performance, and orchestration state drift apart, the whole system becomes unreliable.

### 15.5 Biggest GTM risk
**Overpromising team replacement before proving trustworthy workflow compression.**  
If the product is sold as “AI replacing your GTM team,” users will test it on the hardest cases and lose trust quickly.

### 15.6 The one thing to obsess over
**Founder trust through measurable, reversible, evidence-backed execution.**

If the founder feels:
- “I see why this action exists,”
- “I can approve it safely,”
- “it gets better every month,”

then GrowthOS becomes sticky.

If it feels like orchestration theater, it dies.

---

## 16. Implementation Priorities

### Phase 1 — Prove trustworthy compression
- motion scoring
- approvals
- content and warm outbound prep
- weekly operating review
- structured learning from edits and performance

### Phase 2 — Prove compounding value
- experiments
- lifecycle motion
- playbook versioning
- learning decay / revalidation
- segment priors

### Phase 3 — Prove operating leverage
- multi-user approvals
- ABM and partner motions
- richer attribution
- benchmark insights
- deeper RevOps leak detection

---

## 17. References and Design Inputs

This spec incorporates:
- official GTM and product marketing lifecycle thinking emphasizing planning, launch, and post-launch growth
- RevOps and lifecycle models that connect acquisition, onboarding, retention, and expansion
- modern agent runtime patterns emphasizing durable execution, human-in-the-loop, tracing, memory, and governed tool use
- MCP concepts for structured tools, resources, prompts, and client-controlled sampling
- motion-first and learning-first ideas from prior GrowthOS drafts and GTM motions analysis

Use these as implementation principles, not as excuses to widen v1 scope.

---
