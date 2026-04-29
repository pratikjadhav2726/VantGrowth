# GrowthOS — GitOps (Argo CD + Kustomize)

This directory holds **reference manifests** for deploying GrowthOS to a Kubernetes cluster (for example **K3s**) with **Argo CD** managing sync from Git.

## Layout

| Path | Purpose |
|------|---------|
| `argo-cd/application.yaml` | `Application` CRD pointing at this repo’s `k8s/overlays/dev` (edit `spec.source.repoURL` + `targetRevision` for your fork). |
| `k8s/base` | Namespace, Deployments, Services, **weekly digest CronJob** — image names and tags are placeholders. |
| `k8s/overlays/dev` | Dev overlay: `environment: dev` label. |
| `k8s/overlays/with-ghcr-pull` | Adds `imagePullSecrets: ghcr-pull` to API + web for **private** GHCR images — see [README](k8s/overlays/with-ghcr-pull/README.md). |
| `k8s/overlays/dev-with-ghcr-pull` | **Dev + private registry** in one apply — [README](k8s/overlays/dev-with-ghcr-pull/README.md). |

## Prerequisites

- Cluster with Argo CD installed.
- Container images published for `@growthos/api` and `@growthos/web`. On push to `main` / `master`, GitHub Actions ([`.github/workflows/container-images.yml`](../../.github/workflows/container-images.yml)) builds from [`docker/api.Dockerfile`](../../docker/api.Dockerfile) and [`docker/web.Dockerfile`](../../docker/web.Dockerfile) and pushes to **GHCR** (`ghcr.io/<owner>/growthos-api` / `growthos-web`). Pin tags in [`k8s/overlays/dev/kustomization.yaml`](k8s/overlays/dev/kustomization.yaml) via the `images:` block.
- **Private GHCR packages:** create Secret `ghcr-pull` (see [`k8s/overlays/with-ghcr-pull/README.md`](k8s/overlays/with-ghcr-pull/README.md)), then apply [`k8s/overlays/with-ghcr-pull`](k8s/overlays/with-ghcr-pull) or [`k8s/overlays/dev-with-ghcr-pull`](k8s/overlays/dev-with-ghcr-pull) instead of `dev` alone.

## Apply manually (without Argo)

```bash
kubectl apply -k deploy/gitops/k8s/overlays/dev
# or, for private GHCR images + dev labels:
# kubectl apply -k deploy/gitops/k8s/overlays/dev-with-ghcr-pull
```

## Apply via Argo CD

1. Edit `argo-cd/application.yaml`: set `repoURL` to your Git remote and `targetRevision` to a branch or tag.
2. `kubectl apply -f deploy/gitops/argo-cd/application.yaml`

Argo CD will sync the Kustomize overlay path declared in `spec.source.path`.
