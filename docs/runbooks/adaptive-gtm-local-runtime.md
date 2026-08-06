# Runbook: Adaptive GTM Local Runtime

**Use for:** a disposable development tenant or a pre-production environment.  
**Do not use for:** approving customer-facing artifacts merely to test a route.  
**Runtime note:** This is an operator procedure. It does not claim that Docker
Compose has been executed by this document or its authors.

This runbook exercises the durable path from signal ingestion through experiment
evidence and approval feedback, then shows the founder-safe control-plane and
dead-letter checks. For the model and safety boundaries, read the
[Adaptive GTM Harness](../ADAPTIVE_GTM_HARNESS.md).

## 1. Prepare and start the local stack

Use a local `.env` file only; never commit it or copy production credentials
into it. The checked-in [environment template](../../.env.example) contains
development defaults, not production secrets.

```bash
cp .env.example .env

# Validate the rendered configuration before creating containers.
docker compose -f compose.dev.yaml config --quiet

# Includes the optional bundled n8n service. Omit --profile local-n8n when it
# is not needed for this exercise.
docker compose -f compose.dev.yaml --profile local-n8n up --build -d

docker compose -f compose.dev.yaml ps
docker compose -f compose.dev.yaml logs migrate --tail=100
```

The Compose-exposed endpoints are:

- API: `http://localhost:3091` (inside Compose it remains `http://api:3001`)
- Web: `http://localhost:3080`
- NATS monitoring: `http://localhost:8222`
- Postgres host port: `localhost:5442`

This procedure uses the seeded development tenant by default. Its ID must be
included in both `OUTBOX_TENANT_IDS` and `SIGNAL_ROUTER_TENANT_IDS`, because
those workers deliberately process only explicit tenants. If you use another
disposable tenant, update both values in `.env` before startup (or restart the
two workers after changing them).

Wait for the API and JetStream before sending traffic:

```bash
curl --fail-with-body http://localhost:3091/health | jq .
curl --fail-with-body http://localhost:8222/healthz
docker compose -f compose.dev.yaml logs --tail=100 \
  signal-router outbox-publisher intel-director content-strategist blog-draft critique learning
```

## 2. Set a non-secret request context

Provide values from your secure shell/session. Do not paste a real token into a
terminal transcript, issue, or chat. The API requires the bearer token whenever
`GROWTHOS_API_SERVICE_TOKEN` is configured.

```bash
export GROWTHOS_API_URL="${GROWTHOS_API_URL:-http://localhost:3091}"
# The default is the tenant created by the checked-in development seed.
export GROWTHOS_TENANT_ID="${GROWTHOS_TENANT_ID:-00000000-0000-0000-0001-000000000001}"
: "${GROWTHOS_API_SERVICE_TOKEN:?Set the local service token in GROWTHOS_API_SERVICE_TOKEN}"

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
```

Every request below derives tenancy from `X-Tenant-Id`; never add a tenant ID to
a request body to select another tenant.

## 3. Ingest a signal and observe the durable handoff

The request is idempotent for this tenant and `externalId`. It first writes the
signal to Postgres; the signal router and outbox publisher move it through the
JetStream pipeline asynchronously.

```bash
SIGNAL_RESPONSE="$(
  curl --fail-with-body --silent --show-error \
    -X POST "$GROWTHOS_API_URL/v1/signals" \
    -H "Authorization: Bearer $GROWTHOS_API_SERVICE_TOKEN" \
    -H "X-Tenant-Id: $GROWTHOS_TENANT_ID" \
    -H 'Content-Type: application/json' \
    --data "$(jq -n --arg run_id "$RUN_ID" '{
      externalId: ("runbook-market-" + $run_id),
      signalType: "market",
      source: "operator-runbook",
      payload: {
        kind: "competitor.pricing_change",
        competitor: "Example Competitor",
        summary: "Disposable runbook signal; do not treat as market evidence."
      }
    }')"
)"
printf '%s\n' "$SIGNAL_RESPONSE" | jq .
```

Expected result: HTTP `202` with `accepted: true`. A repeat with the same
`externalId` returns `inserted: false` rather than creating a second signal.

Inspect the worker handoff without assuming a fixed completion time:

```bash
docker compose -f compose.dev.yaml logs --tail=200 \
  signal-router outbox-publisher intel-director content-strategist blog-draft critique learning
```

## 4. Create an experiment, assignment, and outcome evidence

Use an explicit draft → running transition. This is a development experiment,
not proof of a production claim.

```bash
EXPERIMENT_RESPONSE="$(
  curl --fail-with-body --silent --show-error \
    -X POST "$GROWTHOS_API_URL/v1/experiments" \
    -H "Authorization: Bearer $GROWTHOS_API_SERVICE_TOKEN" \
    -H "X-Tenant-Id: $GROWTHOS_TENANT_ID" \
    -H 'Content-Type: application/json' \
    --data "$(jq -n --arg run_id "$RUN_ID" '{
      experimentKey: ("runbook-activation-" + $run_id),
      motion: "inbound_content",
      experimentType: "message_test",
      unitType: "account",
      hypothesis: "The disposable candidate message improves activation evidence.",
      variantA: {headline: "Baseline message"},
      variantB: {headline: "Candidate message"},
      metricName: "activation_rate",
      metricDirection: "increase",
      minSampleSize: 20,
      initialStatus: "draft",
      inputSnapshot: {source: "operator-runbook", disposable: true},
      modelVersion: "runbook-v1",
      promptVersion: "runbook-v1",
      policyVersion: "runbook-v1",
      createdBy: "operator-runbook"
    }')"
)"
EXPERIMENT_ID="$(printf '%s' "$EXPERIMENT_RESPONSE" | jq -er '.experiment.id')"
printf '%s\n' "$EXPERIMENT_RESPONSE" | jq .

curl --fail-with-body --silent --show-error \
  -X POST "$GROWTHOS_API_URL/v1/experiments/$EXPERIMENT_ID/transition" \
  -H "Authorization: Bearer $GROWTHOS_API_SERVICE_TOKEN" \
  -H "X-Tenant-Id: $GROWTHOS_TENANT_ID" \
  -H 'Content-Type: application/json' \
  --data '{"fromStatus":"draft","toStatus":"running"}' | jq .
```

Assign one test entity, then capture an attributed outcome against that exact
assignment:

```bash
ASSIGNMENT_RESPONSE="$(
  curl --fail-with-body --silent --show-error \
    -X POST "$GROWTHOS_API_URL/v1/experiments/$EXPERIMENT_ID/assignments" \
    -H "Authorization: Bearer $GROWTHOS_API_SERVICE_TOKEN" \
    -H "X-Tenant-Id: $GROWTHOS_TENANT_ID" \
    -H 'Content-Type: application/json' \
    --data "$(jq -n --arg run_id "$RUN_ID" '{
      entityType: "account",
      entityId: ("runbook-account-" + $run_id),
      variant: "a",
      assignmentContext: {source: "operator-runbook"}
    }')"
)"
ASSIGNMENT_ID="$(printf '%s' "$ASSIGNMENT_RESPONSE" | jq -er '.assignment.id')"
ACCOUNT_ID="$(printf '%s' "$ASSIGNMENT_RESPONSE" | jq -er '.assignment.entityId')"
printf '%s\n' "$ASSIGNMENT_RESPONSE" | jq .

curl --fail-with-body --silent --show-error \
  -X POST "$GROWTHOS_API_URL/v1/outcomes" \
  -H "Authorization: Bearer $GROWTHOS_API_SERVICE_TOKEN" \
  -H "X-Tenant-Id: $GROWTHOS_TENANT_ID" \
  -H 'Content-Type: application/json' \
  --data "$(jq -n \
    --arg experiment_id "$EXPERIMENT_ID" \
    --arg assignment_id "$ASSIGNMENT_ID" \
    --arg account_id "$ACCOUNT_ID" \
    --arg run_id "$RUN_ID" '{
      experimentId: $experiment_id,
      assignmentId: $assignment_id,
      idempotencyKey: ("runbook-outcome-" + $run_id),
      entityType: "account",
      entityId: $account_id,
      variant: "a",
      metricName: "activation_rate",
      metricValue: 1,
      isGuardrail: false,
      attributionConfidence: 0.9,
      attributionModel: "operator_runbook_v1",
      source: "operator-runbook",
      observedOutcome: {activated: true, disposable: true},
      evidence: {runId: $run_id, source: "operator-runbook"}
    }')" | jq .

curl --fail-with-body --silent --show-error \
  "$GROWTHOS_API_URL/v1/experiments/$EXPERIMENT_ID/observations?metricName=activation_rate" \
  -H "Authorization: Bearer $GROWTHOS_API_SERVICE_TOKEN" \
  -H "X-Tenant-Id: $GROWTHOS_TENANT_ID" | jq .
```

## 5. Add a signal linked to the experiment

The first signal established that general ingestion works. Send this second,
explicitly linked signal after the experiment exists so the router can carry
the experiment lineage into the generated artifact flow:

```bash
LINKED_SIGNAL_RESPONSE="$(
  curl --fail-with-body --silent --show-error \
    -X POST "$GROWTHOS_API_URL/v1/signals" \
    -H "Authorization: Bearer $GROWTHOS_API_SERVICE_TOKEN" \
    -H "X-Tenant-Id: $GROWTHOS_TENANT_ID" \
    -H 'Content-Type: application/json' \
    --data "$(jq -n \
      --arg run_id "$RUN_ID" \
      --arg experiment_id "$EXPERIMENT_ID" '{
        externalId: ("runbook-experiment-linked-market-" + $run_id),
        signalType: "market",
        source: "operator-runbook",
        payload: {
          kind: "competitor.pricing_change",
          experiment_id: $experiment_id,
          competitor: "Example Competitor",
          summary: "Disposable signal linked to the runbook experiment."
        }
      }')"
)"
printf '%s\n' "$LINKED_SIGNAL_RESPONSE" | jq .
```

`worker-signal-router` validates `payload.experiment_id` and includes it in the
durable intel-brief request. The intel, content, and blog-draft contracts retain
that lineage. This does not make the single outcome sufficient evidence for a
promotion; it makes the later artifact and feedback traceable to the experiment.

```bash
docker compose -f compose.dev.yaml logs --tail=200 \
  signal-router outbox-publisher intel-director content-strategist blog-draft critique learning
```

## 6. Complete an approval flow only for a real reviewed artifact

The signal pipeline may create a `blog_draft.v1` asynchronously. List the
tenant's queue and inspect the artifact before making any decision:

```bash
curl --fail-with-body --silent --show-error \
  "$GROWTHOS_API_URL/v1/approvals?outputType=blog_draft.v1&limit=10" \
  -H "Authorization: Bearer $GROWTHOS_API_SERVICE_TOKEN" \
  -H "X-Tenant-Id: $GROWTHOS_TENANT_ID" \
  | jq --arg experiment_id "$EXPERIMENT_ID" '{
      items: [.items[] | select(.payload.experiment_id == $experiment_id)]
    }'
```

If the filtered list is empty, wait for the asynchronous pipeline and inspect
the worker logs rather than approving an unrelated artifact. In a disposable
environment, copy the UUID from a *real reviewed*
`.items[].payload.draft_id` in the filtered output into `APPROVAL_ISSUE_ID`.
Do not invent an ID and do not approve a customer artifact to test this route.

```bash
export APPROVAL_ISSUE_ID='<reviewed blog_draft UUID>'

curl --fail-with-body --silent --show-error \
  -X POST "$GROWTHOS_API_URL/v1/approvals/decide" \
  -H "Authorization: Bearer $GROWTHOS_API_SERVICE_TOKEN" \
  -H "X-Tenant-Id: $GROWTHOS_TENANT_ID" \
  -H 'Content-Type: application/json' \
  --data "$(jq -n --arg issue_id "$APPROVAL_ISSUE_ID" '{
    issueId: $issue_id,
    outputType: "blog_draft.v1",
    action: "approved",
    reviewerNote: "Approved after disposable runbook review.",
    learnOptIn: true
  }')" | jq .
```

The response is an approval-feedback record; it also creates a durable learning
signal. A later learning-proposal approval is different: it is only valid for
an existing proposal in `requires_approval` state, and queues a durable
re-evaluation rather than immediately promoting a change.

```bash
curl --fail-with-body --silent --show-error \
  "$GROWTHOS_API_URL/v1/learning-proposals?status=requires_approval&limit=20" \
  -H "Authorization: Bearer $GROWTHOS_API_SERVICE_TOKEN" \
  -H "X-Tenant-Id: $GROWTHOS_TENANT_ID" | jq .

# Use only after a human has reviewed an existing proposal and its evidence.
# POST /v1/learning-proposals/<proposal-id>/approve
```

## 7. Check the control plane, incidents, and dead letters

The generic control-plane endpoints are intentionally sanitized. Treat a
`partial: true` summary or an unavailable data source as an operational signal,
not a zero or a healthy result.

```bash
curl --fail-with-body --silent --show-error \
  "$GROWTHOS_API_URL/v1/control-plane/summary" \
  -H "Authorization: Bearer $GROWTHOS_API_SERVICE_TOKEN" \
  -H "X-Tenant-Id: $GROWTHOS_TENANT_ID" | jq .

curl --fail-with-body --silent --show-error \
  "$GROWTHOS_API_URL/v1/control-plane/health" \
  -H "Authorization: Bearer $GROWTHOS_API_SERVICE_TOKEN" \
  -H "X-Tenant-Id: $GROWTHOS_TENANT_ID" | jq .

curl --fail-with-body --silent --show-error \
  "$GROWTHOS_API_URL/v1/control-plane/incidents?limit=50" \
  -H "Authorization: Bearer $GROWTHOS_API_SERVICE_TOKEN" \
  -H "X-Tenant-Id: $GROWTHOS_TENANT_ID" | jq .
```

For a protected, local operator check of dead letters, inspect only the
metadata needed for triage. Do not paste full payloads, credentials, or customer
content into tickets:

```bash
docker compose -f compose.dev.yaml exec -T postgres \
  psql -U postgres -d growthos_ci -v tenant_id="$GROWTHOS_TENANT_ID" -c "
    SELECT id,
           created_at,
           payload ->> 'worker' AS worker,
           payload ->> 'source_subject' AS source_subject,
           payload ->> 'stream_sequence' AS stream_sequence,
           payload ->> 'redelivery_count' AS redelivery_count,
           left(coalesce(payload ->> 'error', ''), 300) AS error
      FROM growthos.event_outbox
     WHERE tenant_id = :'tenant_id'::uuid
       AND event_type = 'worker.dead_lettered.v1'
     ORDER BY created_at DESC
     LIMIT 20;"
```

A dead-letter event should lead to a sanitized incident once the outbox
publisher processes it. If the event is present but no incident appears, inspect
the `outbox-publisher` logs and confirm that the tenant is included in
`OUTBOX_TENANT_IDS`. Correct the source problem before replaying work; do not
republish raw messages or bypass the outbox.

## 8. Stop the stack

```bash
docker compose -f compose.dev.yaml down
```

Use `down -v` only when intentionally discarding local Postgres, NATS, and other
named-volume state.
