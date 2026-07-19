# Adaptive GTM Harness

**Status:** Durable, evidence-governed loop implemented
**Contract:** `gtm_product_profile.v1`
**Runtime note:** This document describes implemented code and checked-in
configuration. It is not an attestation that a local Docker Compose runtime has
been started.

## Product goal

GrowthOS is a multi-tenant SaaS harness that can understand, market, and sell
different products without embedding one company's positioning, ICP, funnel, or
success definition in agent code. It improves through measured outcomes and
recovers from operational failures without bypassing commercial or safety
controls.

The platform is not successful because it generated more activity. It is
successful when it improves the tenant's declared business outcomes while
staying inside cost, brand, compliance, consent, and channel guardrails.

## Delivered durable loop

The adaptive loop is now split into an auditable control plane and a recoverable
data plane:

```text
Tenant profile, goals, constraints
                 │
                 ▼
API or signed n8n signal ingestion
                 │
                 ▼
tenant-scoped signal_events inbox (idempotent)
                 │
                 ▼
leased signal router → transactional outbox
                 │
                 ▼
JetStream durable consumers
  intel → content → blog draft → critique → learning
  attribution / warmth signals → durable evaluations
                 │
                 ▼
outcomes, approval feedback, and experiment observations
                 │
                 ▼
evidence gate → human approval when required → immutable promotion
                 │                                      │
                 └───────── regression / rollback ◄─────┘

Failure path: bounded retry → worker.dead_lettered.v1 outbox event
              → sanitized control-plane incident → operator triage
```

In the delivered worker entrypoints, the transactional outbox is the only
runtime publisher to JetStream. Workers acknowledge durable messages only after
their tenant-scoped state transition and downstream outbox event are committed.
This preserves at-least-once delivery without allowing a direct publish to race
a database commit.

## Durable control-plane state

The adaptive control plane persists the records needed to make the loop
inspectable and reversible:

- Experiments define a bounded hypothesis, unit, variants, primary metric,
  guardrails, versions, and input snapshot.
- Assignments keep variant exposure sticky per tenant and entity.
- Observations are append-only, idempotent evidence with attribution confidence,
  cost, source, outcome, and evidence fields.
- Learning proposals retain the evidence-gated lifecycle from collection through
  approval, promotion, or rollback.
- Component-health decisions and incidents are tenant-scoped operational state,
  not log-only signals.

The corresponding tables are protected by tenant RLS. Repository operations set
tenant context inside the same database transaction that performs the read or
write. See the [control-plane repository](../packages/db/src/adaptive-control-plane-repository.ts)
and [migration](../packages/db/drizzle/0003_adaptive_control_plane.sql).

## Universal product context

`@growthos/core` owns the strict `gtmProductProfileSchema`. It describes:

- the product, business model, sales motion, value propositions, and proof;
- multiple audiences with pains, outcomes, triggers, and explicit exclusions;
- canonical awareness, activation, conversion, and retention events;
- measurable goals and time horizons;
- budget, currency, claim, channel, and regulatory constraints.

The profile is stored under the tenant setting key `adaptiveGtm`; the API
validates it before persistence. Workers consume the profile rather than a
hard-coded vertical assumption.

## Evidence-governed learning

One review, click, critique, or conversion is an observation, not a learning.
`evaluateLearningProposal` uses persisted A/B evidence to apply a deterministic
promotion gate:

1. Require the configured observation count and independent entities.
2. Compare candidate and baseline metrics.
3. Enforce confidence, relative-lift, and guardrail thresholds.
4. Keep attribution confidence visible rather than treating weak attribution as
   causal proof.
5. Require human approval for proposals that need it.
6. Re-read the latest evidence after that approval; approval is not a waiver for
   a later regression or guardrail breach.
7. Promote only after an immutable version exists, and retain a rollback
   reference.

Approval of a learning proposal atomically changes its lifecycle state and adds
`learning.proposal.approved.v1` to the outbox. The Learning Worker consumes that
event durably and re-evaluates evidence before any promotion. The normal artifact
approval route similarly records feedback and emits a durable
`learning.signal.v1` event.

## Bounded recovery and incident visibility

The shared JetStream consumer gives workers an explicit acknowledgement boundary,
maximum delivery count, retry delay, and maximum pending messages. When a message
exhausts its retry budget, the worker writes `worker.dead_lettered.v1` to the
tenant outbox. The outbox publisher materializes a sanitized incident before it
marks that event consumed.

This means operators can use the tenant-scoped control-plane APIs to see a
failure without exposing raw connector payloads or stack traces to a generic
dashboard. Raw dead-letter payloads remain protected operational data. The
[adaptive runtime runbook](runbooks/adaptive-gtm-local-runtime.md) covers the
safe inspection path.

## SaaS control-plane boundaries

- **Tenant isolation:** profiles, experiments, evidence, proposals, health, and
  incidents are tenant-scoped; tenant identity is supplied by request headers or
  tenant-scoped event subjects, never by an untrusted body field.
- **Control plane:** policy, approvals, budget-aware decisions, lifecycle
  promotion, health, and incident history.
- **Data plane:** signal ingestion, routing, generated artifacts, connector
  dispatch, durable worker processing, and outcome capture.
- **Risk tiers:** public, commercial, personal-data, spend, and destructive
  actions require stricter policy and approval boundaries.
- **Last known good:** prompts, models, playbooks, skills, routing, and
  connector configuration are immutable versions with rollback references.
- **External actions:** the n8n dispatch lifecycle is idempotent and records a
  terminal callback before a request is settled.

## Operator-facing interfaces

The API exposes tenant-scoped surfaces for the delivered loop:

- `POST /v1/signals` for idempotent signal ingestion.
- `POST /v1/experiments`, lifecycle/assignment endpoints, and `POST /v1/outcomes`
  for experiment evidence.
- `GET /v1/approvals` and `POST /v1/approvals/decide` for artifact feedback.
- `GET /v1/learning-proposals` and `POST /v1/learning-proposals/:id/approve`
  for proposal governance.
- `GET /v1/control-plane/summary`, `/health`, and `/incidents` for the
  founder-safe operational read model.

When `GROWTHOS_API_SERVICE_TOKEN` is set, control-plane reads require its
bearer token. `/summary` reports `partial` and per-source availability rather
than presenting an unavailable source as empty or healthy; `/health` and
`/incidents` return `503` when their respective stores are unavailable.

## Operational completion criteria

The code path is durable, but production operation still requires deliberate
configuration and evidence discipline:

1. Configure unique production secrets, tenant allowlists, NATS/Postgres
   endpoints, and external callback URLs; do not reuse development defaults.
2. Run migrations and use the [operator runbook](runbooks/adaptive-gtm-local-runtime.md)
   to verify the signal, experiment, outcome, approval, and incident read paths.
3. Monitor outbox depth, JetStream consumer health, component health, and open
   incidents before enabling unattended actions.
4. Calibrate metric definitions, attribution models, minimum sample sizes, and
   guardrail tolerances per tenant before trusting a promotion recommendation.
5. Keep public or commercial execution behind the applicable approval and n8n
   callback policy.

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
