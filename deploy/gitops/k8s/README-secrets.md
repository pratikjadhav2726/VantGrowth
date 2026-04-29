# Kubernetes secrets — GrowthOS runtime

The API Deployment loads optional environment variables from a Secret named **`growthos-runtime`** (`envFrom`). If the Secret is missing, pods still schedule; the API will not connect to Postgres until you apply a real Secret.

## Create the Secret (imperative)

```bash
kubectl -n growthos create secret generic growthos-runtime \
  --from-literal=DATABASE_URL='postgresql://user:pass@host:5432/growthos?sslmode=require' \
  --from-literal=GROWTHOS_API_SERVICE_TOKEN='your-bearer-token-for-mutations' \
  --from-literal=GROWTHOS_DIGEST_TENANT_ID='00000000-0000-0000-0001-000000000001' \
  --from-literal=GROWTHOS_DIGEST_RECIPIENT_EMAIL='founder@example.com' \
  --dry-run=client -o yaml | kubectl apply -f -
```

| Key | Used by | Notes |
|-----|---------|--------|
| `DATABASE_URL` | API | Required for real persistence. |
| `GROWTHOS_API_SERVICE_TOKEN` | API + [weekly digest CronJob](./README-weekly-digest-cronjob.md) | Bearer token for mutation routes; CronJob sends `Authorization` when set. |
| `GROWTHOS_DIGEST_TENANT_ID` | CronJob | **Required** for `growthos-weekly-digest` — `X-Tenant-Id` for digest send. |
| `GROWTHOS_DIGEST_RECIPIENT_EMAIL` | CronJob (optional) | Passed as JSON `recipientEmail` to `POST /v1/digest/send` (Postal path). |

Add or omit keys as needed. Never commit real values into Git.

## Weekly digest CronJob

See [`README-weekly-digest-cronjob.md`](./README-weekly-digest-cronjob.md). The CronJob reads the same **`growthos-runtime`** Secret (`envFrom`).

## External Secrets Operator (optional)

If you run [External Secrets Operator](https://external-secrets.io/), use [`external-secret-runtime.example.yaml`](./external-secret-runtime.example.yaml) as a template: point `secretStoreRef` and `remoteRef` at your Vault / AWS Secrets Manager / GCP SM backend, then apply.

## Sealed Secrets (optional)

Generate a `SealedSecret` with `kubeseal` and commit only the sealed manifest; the cluster controller materializes the real `Secret`.
