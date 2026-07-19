# n8n End-to-End Integration Runbook

GrowthOS uses n8n as the connector fabric for external SaaS systems. GrowthOS owns
the agentic reasoning, approvals, memory, audit trail, and policy checks. n8n owns
vendor credentials, SaaS workflow execution, retries, and channel-specific nodes.

This keeps the core product scalable: every new founder integration should become
either a normalized inbound signal or an approved outbound dispatch action.

## Local Stack

Start GrowthOS against your existing n8n instance:

```bash
cp .env.example .env
docker compose -f compose.dev.yaml up --build
```

Useful local URLs:

- GrowthOS API: `http://localhost:3091`
- Web app: `http://localhost:3080`
- n8n: your existing instance, usually `http://localhost:5678`

The compose stack starts:

- `api`, which receives signed n8n signals and enqueues dispatch actions.
- `outbox-publisher`, which drains `n8n.dispatch.requested.v1` rows to n8n.

If you want GrowthOS to run a disposable bundled n8n instead, start compose with:

```bash
docker compose -f compose.dev.yaml --profile local-n8n up --build
```

For the bundled n8n profile, set the dispatch URL to
`http://n8n:5678/webhook/growthos/dispatch`. The callback default targets
`http://api:3001/v1/n8n/dispatch-results` over the internal Compose network.

When n8n runs on the host or in another environment, override both URLs with
addresses it can reach, for example use
`http://host.docker.internal:5678/webhook/growthos/dispatch` for dispatch and
`http://host.docker.internal:3091/v1/n8n/dispatch-results` for a host process
or `https://api.example.com/v1/n8n/dispatch-results` in production.

## GrowthOS Environment

Required for end-to-end n8n:

```bash
N8N_BASE_URL=http://localhost:5678
N8N_SHARED_SECRET=growthos-dev-n8n-shared-secret
N8N_DISPATCH_WEBHOOK_URL=http://host.docker.internal:5678/webhook/growthos/dispatch
N8N_DISPATCH_RESULT_CALLBACK_URL=http://api:3001/v1/n8n/dispatch-results
N8N_TIMEOUT_MS=10000
N8N_DISPATCH_LEASE_MS=120000
OUTBOX_TENANT_IDS=00000000-0000-0000-0001-000000000001
OUTBOX_BATCH_SIZE_PER_TENANT=100
OUTBOX_POLL_INTERVAL_MS=1000
OUTBOX_ENABLE_LISTEN_NOTIFY=true
```

For production, replace the shared secret with a random secret, store it in the
secrets manager, and scope one n8n credential set per tenant or founder account.

## n8n Credentials

Create these n8n credentials before building workflows:

- GrowthOS API HTTP credential: base URL plus `Authorization: Bearer <GROWTHOS_API_SERVICE_TOKEN>`.
- GrowthOS HMAC secret: same value as `N8N_SHARED_SECRET`.
- Reddit OAuth credential for read and write operations that the founder approves.
- LinkedIn OAuth credential for sanctioned posting operations.
- Email, CRM, CMS, analytics, support, and enrichment credentials as tenants need them.

Keep credentials tenant-scoped. Do not share one founder's social or CRM credential
across another founder's workflows.

## Workflow 1: Reddit Signal Ingest

Purpose: monitor Reddit for founder-relevant buying intent, objections,
competitor mentions, and community questions.

Recommended workflow:

1. `Schedule Trigger` or channel-specific trigger.
2. `Reddit` node:
   - Search subreddits, retrieve subreddit posts, retrieve post comments, or get user/profile context.
   - Keep subreddit lists in workflow variables or tenant config.
3. `Code` or `Set` node to normalize the item into GrowthOS format.
4. `Crypto` node to compute HMAC SHA-256 over the exact raw JSON body.
5. `HTTP Request` node:
   - Method: `POST`
   - URL in Docker: `http://api:3001/v1/n8n/signals`
   - URL from host/cloud: `https://<growthos-api>/v1/n8n/signals`
   - Headers:
     - `Content-Type: application/json`
     - `X-Tenant-Id: <tenant uuid>`
     - `Idempotency-Key: reddit:<sourceRecordId>`
     - `X-GrowthOS-Signature: sha256=<hmac hex>`
   - Body: canonical signal envelope.

Example body:

```json
{
  "eventId": "reddit:t1_comment_123",
  "source": "reddit",
  "signalType": "community",
  "occurredAt": "2026-07-11T12:00:00.000Z",
  "workflowId": "growthos-ingest-reddit",
  "executionId": "={{$execution.id}}",
  "payload": {
    "channel": "reddit",
    "sourceRecordId": "t1_comment_123",
    "sourceUrl": "https://www.reddit.com/r/startups/comments/abc/comment/123",
    "actor": {
      "handle": "founderbuyer"
    },
    "subject": "Looking for founder-led GTM workflows",
    "text": "Any recommendations for founder-led GTM?",
    "engagement": {
      "kind": "comment",
      "score": 0.72,
      "counts": {
        "upvotes": 14,
        "replies": 3
      }
    },
    "evidence": [
      {
        "type": "url",
        "uri": "https://www.reddit.com/r/startups/comments/abc/comment/123"
      }
    ],
    "metadata": {
      "subreddit": "startups"
    }
  }
}
```

## Workflow 2: LinkedIn Signal Ingest

Use the built-in LinkedIn node for sanctioned post creation. For inbound LinkedIn
signals, use only approved sources:

- Official LinkedIn APIs and webhooks available to the tenant.
- Founder-exported CSVs or CRM-enriched activity.
- Approved enrichment providers with contractual permission.
- Manual founder review queues.

Do not implement scraping or browser automation as the default path. Normalize
LinkedIn engagement into `community` or `icp` signals, and store original URLs or
record IDs in `payload.evidence`.

## Workflow 3: GrowthOS Dispatch Gateway

Purpose: receive approved GrowthOS actions and fan out to the correct SaaS node.

Create a workflow named `growthos-dispatch-gateway`:

1. `Webhook` trigger:
   - Method: `POST`
   - Path: `growthos/dispatch`
   - Production URL must match `N8N_DISPATCH_WEBHOOK_URL`.
2. `Code` node:
   - Verify `X-GrowthOS-Signature` against the exact raw dispatch body using
     `N8N_SHARED_SECRET`; reject unsigned or invalid requests.
   - Validate `idempotencyKey`, `actionType`, and `payload.channel`.
   - Drop duplicates using n8n data store or a durable external store.
   - Enforce workflow-level rate limits and tenant/channel kill switches.
3. `Switch` node on `actionType`.
4. Channel branches:
   - `reddit.post.submit`: Reddit submit post.
   - `reddit.comment.submit`: Reddit submit comment.
   - `linkedin.post.create`: LinkedIn create post.
   - `linkedin.dm.send`: keep draft-first unless the tenant has approved, sanctioned DM capability.
   - `email.send`: email provider node.
   - `crm.note.create`: CRM node.
   - `cms.post.publish`: CMS node.
   - `analytics.event.record`: analytics node.
   - `custom.execute`: tenant-specific workflow.
5. Final `Respond to Webhook` node:

```json
{
  "ok": true,
  "actionId": "={{$json.actionId}}",
  "actionType": "={{$json.actionType}}",
  "externalId": "={{$json.externalId}}",
  "workflowId": "growthos-dispatch-gateway",
  "executionId": "={{$execution.id}}"
}
```

6. After the downstream provider reaches a terminal state, post a signed
   callback to `{{$json.callback.url}}` from the dispatch payload. Use a stable
   `callbackId` such as `<executionId>:completed`, and retry the exact same
   callback until GrowthOS returns a 2xx response.

GrowthOS treats HTTP 429 and 5xx from this webhook as retryable. Non-retryable
4xx responses consume the outbox row, so use 4xx only for permanent policy or
payload failures.

### Terminal dispatch callback

Sign the exact JSON body using `N8N_SHARED_SECRET` and send the resulting HMAC
in `X-GrowthOS-Signature` when calling the `callback.url` supplied by GrowthOS:

```json
{
  "tenantId": "00000000-0000-0000-0001-000000000001",
  "actionId": "act_123",
  "idempotencyKey": "act_123",
  "callbackId": "execution_456:completed",
  "status": "completed",
  "workflowId": "growthos-dispatch-gateway",
  "executionId": "execution_456",
  "providerReference": "provider_message_789",
  "outcome": {
    "delivered": true
  },
  "occurredAt": "2026-07-19T12:00:00.000Z"
}
```

For a terminal failure, set `status` to `failed` and include `errorCode`, a
redacted `errorMessage`, and a structured `outcome`. GrowthOS applies the
callback exactly once, emits an outcome event for learning, and opens a durable
control-plane incident for failures.

Example LinkedIn post dispatch:

```json
{
  "tenantId": "00000000-0000-0000-0001-000000000001",
  "actionId": "linkedin-post-001",
  "actionType": "linkedin.post.create",
  "approvedBy": "founder",
  "idempotencyKey": "linkedin-post-001",
  "payload": {
    "channel": "linkedin",
    "postAs": "person",
    "ownerId": "urn:li:person:123",
    "text": "Shipping a new founder-led GTM workflow today.",
    "mediaUrls": [],
    "dryRun": false,
    "metadata": {
      "campaign": "launch"
    }
  }
}
```

Example Reddit comment dispatch:

```json
{
  "tenantId": "00000000-0000-0000-0001-000000000001",
  "actionId": "reddit-comment-001",
  "actionType": "reddit.comment.submit",
  "approvedBy": "founder",
  "idempotencyKey": "reddit-comment-001",
  "payload": {
    "channel": "reddit",
    "parentId": "t1_comment_123",
    "text": "Helpful founder-approved answer.",
    "dryRun": false,
    "metadata": {
      "subreddit": "startups"
    }
  }
}
```

## Smoke Tests

Generate a signed inbound body:

```bash
BODY='{"eventId":"reddit:t1_test","source":"reddit","signalType":"community","occurredAt":"2026-07-11T12:00:00.000Z","payload":{"channel":"reddit","sourceRecordId":"t1_test","text":"testing n8n ingest"}}'
SIG=$(BODY="$BODY" node -e 'const crypto=require("crypto"); const body=process.env.BODY; console.log(crypto.createHmac("sha256", process.env.N8N_SHARED_SECRET || "growthos-dev-n8n-shared-secret").update(body).digest("hex"))')
curl -i http://localhost:3091/v1/n8n/signals \
  -H 'Content-Type: application/json' \
  -H 'X-Tenant-Id: 00000000-0000-0000-0001-000000000001' \
  -H 'Idempotency-Key: reddit:t1_test' \
  -H "X-GrowthOS-Signature: sha256=$SIG" \
  --data "$BODY"
```

Enqueue an outbound dispatch:

```bash
curl -i http://localhost:3091/v1/n8n/dispatch \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer growthos-dev-service-token' \
  --data '{
    "tenantId": "00000000-0000-0000-0001-000000000001",
    "actionId": "email-smoke-001",
    "actionType": "email.send",
    "approvedBy": "founder",
    "idempotencyKey": "email-smoke-001",
    "payload": {
      "channel": "email",
      "to": ["buyer@example.com"],
      "subject": "GrowthOS n8n smoke test",
      "text": "This should be delivered by the n8n dispatch gateway."
    }
  }'
```

Confirm `outbox-publisher` logs show either a successful dispatch or a retryable
n8n webhook failure. If the n8n workflow has not been activated yet, the outbox
row stays unconsumed on retryable failures.

After n8n accepts the dispatch, validate terminal outcome capture with the same
shared-secret HMAC (replace the IDs with the values in the dispatch payload):

```bash
RESULT='{"tenantId":"00000000-0000-0000-0001-000000000001","actionId":"email-smoke-001","idempotencyKey":"email-smoke-001","callbackId":"smoke-execution-1:completed","status":"completed","executionId":"smoke-execution-1","outcome":{"delivered":true}}'
RESULT_SIG=$(RESULT="$RESULT" node -e 'const crypto=require("crypto"); console.log(crypto.createHmac("sha256", process.env.N8N_SHARED_SECRET || "growthos-dev-n8n-shared-secret").update(process.env.RESULT).digest("hex"))')
curl -i http://localhost:3091/v1/n8n/dispatch-results \
  -H 'Content-Type: application/json' \
  -H "X-GrowthOS-Signature: sha256=$RESULT_SIG" \
  --data "$RESULT"
```

Repeat the same callback and verify the response says `duplicate: true`; the
action outcome must not be applied twice.

## Rollout Policy

Start with read-heavy signals and draft-first actions:

1. Reddit ingest plus founder-approved Reddit comments.
2. LinkedIn post creation after founder approval.
3. Email and CRM notes with strict per-tenant rate limits.
4. CMS publishing and analytics events.
5. Tenant-specific integrations through `custom.execute`.

Default limits should be set in n8n workflow variables and mirrored in GrowthOS
policy checks:

- LinkedIn posts: low daily cap until trust is established.
- Reddit comments: low daily cap per subreddit and account.
- Email sends: per-founder and per-domain caps.
- DMs: draft-first unless sanctioned provider/API access is confirmed.

Every workflow must propagate `actionId`, `idempotencyKey`, `workflowId`, and
`executionId` so GrowthOS can audit who approved what, when it ran, and which
external record was touched.

## References

- n8n Reddit node: https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.reddit/
- n8n LinkedIn node: https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.linkedin/
- n8n Webhook node: https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/
- n8n Crypto node: https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.crypto/
