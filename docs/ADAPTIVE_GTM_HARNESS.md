# Adaptive GTM Harness

**Status:** Foundation implemented  
**Contract:** `gtm_product_profile.v1`

## Product goal

GrowthOS is a multi-tenant SaaS harness that can understand, market, and sell
different products without embedding one company's positioning, ICP, funnel, or
success definition in agent code. It improves through measured outcomes and
recovers from operational failures without bypassing commercial or safety
controls.

The platform is not considered successful because it generated more activity.
It is successful when it improves the tenant's declared business outcomes while
staying inside cost, brand, compliance, consent, and channel guardrails.

## Closed-loop model

```text
Product profile + goals + constraints
                 │
                 ▼
        Sense market and funnel signals
                 │
                 ▼
      Decide motion, segment, offer, channel
                 │
                 ▼
       Execute through governed workflows
                 │
                 ▼
   Measure outcomes, cost, quality, attribution
                 │
                 ▼
 Experiment → critique → evidence gate → promote
                 │                         │
                 └──── rollback ◄──────────┘
```

Every decision must retain the input snapshot, model and prompt versions,
playbook version, policy version, evidence, cost, output, approval, and observed
outcome. This makes learning auditable, replayable, tenant-scoped, and reversible.

## Universal product context

`@growthos/core` now owns a strict `gtmProductProfileSchema`. It describes:

- the product, business model, sales motion, value propositions, and proof;
- multiple audiences with pains, outcomes, triggers, and explicit exclusions;
- canonical awareness, activation, conversion, and retention events;
- measurable goals and time horizons;
- budget, currency, claim, channel, and regulatory constraints.

Workers consume this profile instead of hard-coded vertical assumptions. The
profile is accepted under the tenant setting key `adaptiveGtm`, where the API
validates it before persistence.

## Self-learning policy

One review, click, critique, or conversion is an observation—not a learning.
`evaluateLearningProposal` applies a deterministic promotion gate:

1. Collect a minimum number of observations across independent entities.
2. Require a configured confidence level.
3. Compare the candidate with a baseline or holdout.
4. Reject any candidate that harms a guardrail beyond tolerance.
5. Require a minimum relative lift.
6. Require a human decision for high- and critical-risk changes.
7. Promote a new immutable version; never mutate the active version in place.
8. Continue monitoring and automatically roll back on regression.

Useful learning signals include approval edits, rejection reasons, replies,
meetings, opportunities, activation, conversion, retention, revenue, cost,
unsubscribes, complaints, and policy violations. Attribution confidence must be
stored with the outcome so weak attribution cannot become strong policy.

## Self-healing policy

`decideHealingAction` gives agents, workflows, and connectors one shared health
state machine:

```text
healthy ──threshold breach──► degraded ──retry──► recovering
   ▲                              │                   │
   └────────health checks pass────┴───────────────────┘
                                  │
                     attempts exhausted / guardrail breach
                                  ▼
                             quarantined
                         rollback + escalation
```

The decision uses dependency availability, error rate, consecutive failures,
latency, staleness, recovery attempts, fallback availability, and the presence
of a last-known-good version. External actions stop during unsafe recovery or
quarantine. Recovery is bounded and uses exponential backoff; it never retries
forever.

## SaaS control-plane boundaries

- **Tenant isolation:** profile, evidence, experiments, versions, budgets, and
  incidents are always tenant-scoped and protected by RLS.
- **Control plane:** policy, approvals, budgets, version promotion, health, and
  audit history.
- **Data plane:** signal ingestion, content generation, outreach, connector
  dispatch, and outcome capture.
- **Risk tiers:** internal read-only actions may run automatically; public,
  commercial, personal-data, spend, and destructive actions require stricter
  policy and approval.
- **Last known good:** prompts, models, playbooks, skills, routing, and connector
  configuration are immutable versions with a rollback pointer.
- **Evaluation:** offline replay prevents obvious regressions; online canaries
  establish causal lift before general promotion.

## Delivery sequence

The contracts and deterministic decision engines are implemented. The remaining
production wiring should proceed in this order:

1. Persist experiment assignments, observations, proposals, incidents, and
   component health in tenant-scoped Postgres tables. The Learning Worker now
   emits proposals and requires an evidence provider before promotion; durable
   evidence aggregation is the next storage step.
2. Wrap n8n, LLM, NATS, and external-channel calls with the healing decision,
   idempotency keys, retry budgets, fallbacks, and dead-letter recovery.
3. Feed attribution and funnel outcomes back into experiment observations.
4. Add a founder control-center view for goals, live experiments, learned
   changes, rollbacks, health, incidents, spend, and autonomy settings.
5. Run canary promotion by tenant/segment, then widen only after guardrail and
   outcome checks pass.

## Non-negotiable invariants

- No cross-tenant learning from private data. Global patterns must be aggregated,
  anonymized, consented, and separately governed.
- No direct production mutation from raw model output or a single critique.
- No optimization on proxy engagement when the declared business outcome is
  available.
- No unbounded retries, silent failures, unversioned prompts, or irreversible
  promotions.
- No autonomous public, commercial, sensitive, or spend-increasing action outside
  the tenant's explicit policy.
