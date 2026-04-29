# Private GHCR images — `imagePullSecrets`

Use this overlay when API and web images are **private** on GitHub Container Registry and the cluster must authenticate to pull them.

**Overlay path:** [`kustomization.yaml`](./kustomization.yaml) — merges [../../base](../../base) with strategic-merge patches that set:

```yaml
spec:
  template:
    spec:
      imagePullSecrets:
        - name: ghcr-pull
```

on Deployments `growthos-api` and `growthos-web` only (the digest **CronJob** uses public `curlimages/curl`).

**Combined dev + GHCR:** use [`../dev-with-ghcr-pull`](../dev-with-ghcr-pull/) for the same pull patches **and** the `environment: dev` label (single `kubectl apply -k`).

## 1. Create the pull Secret

### Option A — Personal access token (PAT)

Create a fine-grained or classic PAT with **`read:packages`** (and `repo` if the package is tied to a private repo). Then:

```bash
kubectl -n growthos create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io \
  --docker-username=YOUR_GITHUB_USERNAME \
  --docker-password=ghp_xxxxxxxx \
  --dry-run=client -o yaml | kubectl apply -f -
```

### Option B — Workload identity / short-lived credentials (advanced)

On EKS/GKE/AKS, prefer **IRSA**, **Workload Identity**, or **ESO** syncing a registry `.dockerconfigjson` from Vault or a cloud secret store instead of long-lived PATs in the cluster.

## 2. Apply manifests

```bash
# Registry auth only (same labels as base)
kubectl apply -k deploy/gitops/k8s/overlays/with-ghcr-pull

# Dev labels + registry auth (recommended for private images in dev)
kubectl apply -k deploy/gitops/k8s/overlays/dev-with-ghcr-pull
```

## 3. Argo CD

Point `spec.source.path` at `deploy/gitops/k8s/overlays/with-ghcr-pull` or `dev-with-ghcr-pull` after the `ghcr-pull` Secret exists in the namespace (create it out-of-band or via ESO).

## 4. Verify

```bash
kubectl -n growthos get pods -o wide
kubectl -n growthos describe pod -l app.kubernetes.io/name=growthos-api
```

Confirm events show **Successfully pulled image**, not `ImagePullBackOff`.
