# Weekly digest CronJob

Manifest: [`base/cronjob-weekly-digest.yaml`](./base/cronjob-weekly-digest.yaml) (included in the base Kustomization).

## Behaviour

- **Schedule:** `0 22 * * 0` — Sunday 22:00 **UTC**. Override in a Kustomize overlay if you need a founder-local “Sunday evening” window (e.g. `America/Los_Angeles` via a second CronJob or external scheduler).
- **Target:** `POST ${GROWTHOS_API_BASE_URL}/v1/digest/send` (in-cluster default: `http://growthos-api.growthos.svc.cluster.local`).
- **Auth:** If `GROWTHOS_API_SERVICE_TOKEN` is present in Secret `growthos-runtime`, the job sends `Authorization: Bearer <token>` (required when the API enforces `GROWTHOS_API_SERVICE_TOKEN`).
- **Tenant:** `GROWTHOS_DIGEST_TENANT_ID` must be set in `growthos-runtime` (the job exits with an error at startup if missing — `set -u` / `:?` guard).
- **Optional recipient override:** `GROWTHOS_DIGEST_RECIPIENT_EMAIL` is sent as `{ "recipientEmail": "..." }` when set; otherwise the request body is `{}` and the API falls back to env-based recipients.

## Manual run

```bash
kubectl -n growthos create job --from=cronjob/growthos-weekly-digest growthos-weekly-digest-manual-$(date +%s)
```

## Suspend (maintenance)

```bash
kubectl -n growthos patch cronjob growthos-weekly-digest -p '{"spec":{"suspend":true}}'
```
