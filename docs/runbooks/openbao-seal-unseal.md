# Runbook: OpenBao Seal / Unseal

**Severity:** P1 — secrets unavailable; tenant provisioning blocked; any service that reads secrets at startup will fail to start.  
**Owner:** Platform on-call + Security.  
**Last reviewed:** 2026-04-28

---

## Architecture context

GrowthOS uses **OpenBao** (the open-source Vault fork) for:

- Per-tenant KMS envelope encryption keys  
- LLM API key storage (Anthropic, OpenAI, Perplexity)  
- Gitea admin token  
- MinIO access credentials  

OpenBao is **auto-unsealed in dev mode** (in-memory, no persistence — see Compose section). In production it uses **Shamir secret sharing** by default or an auto-unseal provider (AWS KMS / GCP KMS / Transit unseal).

| Environment | Unseal mode | Root token |
|---|---|---|
| Local Compose dev | Dev mode (auto-unseal, in-memory) | `growthos-dev-root-token` |
| Staging / production | Shamir (default) or KMS auto-unseal | Stored in 1Password > `OpenBao Root Token (staging)` |

---

## Symptoms of a sealed OpenBao

| Signal | Where |
|---|---|
| `GET /v1/sys/health` returns `{"sealed": true}` or HTTP 503 | OpenBao `/v1/sys/health` endpoint |
| Worker logs: `"permission denied"` or `"403 Forbidden"` on secrets read | Structured logs: `service = growthos.*` with `err.message` containing vault/bao path |
| Tenant provisioning workflow fails at `read-tenant-secrets` step | `worker-workflow-callback` logs |
| `POST /v1/workflows/tenant-provisioning` returns `503` | `apps/api` span |

---

## Detection

```bash
# Check seal status (no auth required)
curl -s http://localhost:8200/v1/sys/seal-status | jq '{sealed: .sealed, t: .t, n: .n, progress: .progress}'
# sealed: true = sealed; sealed: false = unsealed and healthy

# Check health (200 = ok, 503 = sealed or standby)
curl -s -o /dev/null -w "%{http_code}" http://localhost:8200/v1/sys/health
```

---

## Dev / local Compose

OpenBao runs in **dev mode** (`server -dev`). It never seals and all data is in-memory. If the container stops, all secrets are lost.

```bash
# Restart (data loss — only safe for dev)
docker compose -f compose.yaml restart openbao

# Verify health
curl -s http://localhost:8200/v1/sys/health | jq .initialized
# Expected: true

# Re-provision dev secrets after restart (they are gone)
# See docs/dev-secrets-init.sh (to be created in Phase 0/Track E)
VAULT_ADDR=http://localhost:8200 \
VAULT_TOKEN=growthos-dev-root-token \
  vault secrets enable -path=secret kv-v2 || true

# Quick smoke
curl -s \
  -H "X-Vault-Token: growthos-dev-root-token" \
  http://localhost:8200/v1/sys/health | jq .
```

---

## Production — unseal procedure (Shamir)

OpenBao seals itself when:
- The process restarts (intentionally or due to crash)
- A **seal** API call is issued (emergency stop)
- The storage backend becomes unavailable

The Shamir configuration requires `t` of `n` key shares to unseal (default: 3 of 5).

### Step 1 — Obtain key shares

Key shares are stored in **1Password** > `OpenBao Unseal Keys (production)`. Each unseal key is an individual secret. Retrieve at least `t` (threshold) shares.

**Never store all key shares in the same location.** Distribute them across at least `t` individuals or secure storage locations.

### Step 2 — Unseal each node

```bash
export BAO_ADDR=https://<openbao-host>:8200

# Submit the first key share (repeat for each share up to the threshold)
bao operator unseal
# Prompt: "Unseal Key (will be hidden):"
# Enter key share 1

bao operator unseal
# Enter key share 2

bao operator unseal
# Enter key share 3 (threshold reached — OpenBao unseals)

# Verify
bao status
# Sealed: false
```

If running multiple OpenBao nodes (HA mode with Raft), unseal each node independently:

```bash
for node in openbao-1 openbao-2 openbao-3; do
  BAO_ADDR=https://$node:8200 bao operator unseal  # repeat t times per node
done
```

### Step 3 — Verify applications can read secrets

```bash
# Authenticate as the growthos-api policy token
export VAULT_TOKEN=$(cat /etc/growthos/bao-app-token)  # or from K8s secret

# Read a known secret to confirm the storage backend is healthy
bao kv get secret/growthos/llm-keys

# Confirm health
bao status
```

### Step 4 — Confirm service recovery

After unsealing, services that read secrets at startup (workers, API) need to be restarted if they failed to initialise:

```bash
kubectl rollout restart deployment/growthos-api -n growthos
kubectl rollout restart deployment/growthos-worker-outbox-publisher -n growthos
# Repeat for other workers as needed
```

---

## Production — auto-unseal (KMS)

If production is configured with KMS auto-unseal (recommended for unattended restarts):

```
# AWS KMS: OpenBao config.hcl
seal "awskms" {
  region     = "us-east-1"
  kms_key_id = "alias/growthos-openbao-autounseal"
}
```

In this mode, OpenBao unseals itself automatically on restart using the KMS key. No human intervention is needed unless the KMS key is deleted or the IAM role loses access.

**If KMS auto-unseal fails:**

```bash
# Check KMS reachability from the OpenBao host
aws kms describe-key --key-id alias/growthos-openbao-autounseal

# Check IAM role permissions (must include kms:Decrypt, kms:DescribeKey)
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::<account>:role/growthos-openbao \
  --action-names kms:Decrypt \
  --resource-arns arn:aws:kms:us-east-1:<account>:key/<key-id>
```

---

## Emergency seal

If a security incident requires immediately sealing OpenBao:

```bash
# Seal immediately (requires a token with sudo capability on /sys/seal)
BAO_ADDR=https://<openbao-host>:8200 bao operator seal

# Verify
curl -s http://<openbao-host>:8200/v1/sys/seal-status | jq .sealed
# Expected: true
```

After sealing, all secrets reads will return `403`. Applications will start failing within their token renewal window (default: 768h). Plan unseal within SLO window.

---

## Root-cause categories

| Category | Signs | Resolution |
|---|---|---|
| Process crash / OOM | Node logs: OOM kill | Restart + unseal; scale memory |
| Storage backend unavailable (Raft) | `bao status` shows storage error | Restore Raft quorum; restart followers |
| Operator accidentally sealed | Audit log shows `sys/seal` call | Normal unseal procedure |
| KMS key deleted / IAM revoked | `bao status` shows KMS error | Restore KMS key or IAM role; trigger unseal |
| Token expired (root / init) | `403` on unseal attempt | Use a valid unseal key (not a token) — unseal uses keys, not tokens |

---

## Post-incident checklist

- [ ] Root cause documented.
- [ ] Secrets re-provisioned for dev environments (in-memory data lost on restart).
- [ ] All services restarted and healthy.
- [ ] Audit log reviewed for unexpected seal/unseal events.
- [ ] Key share distribution policy reviewed (are all shares in one person's possession?).
- [ ] If using Shamir, consider migrating to KMS auto-unseal to prevent this class of incident.
- [ ] Review OpenBao version; check for known Raft/seal bugs.
