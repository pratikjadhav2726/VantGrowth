# GrowthOS — GitOps (Argo CD + Kustomize)

This directory holds **reference manifests** for deploying GrowthOS to a Kubernetes cluster (for example **K3s**) with **Argo CD** managing sync from Git.

## Layout

| Path | Purpose |
|------|---------|
| `argo-cd/application.yaml` | `Application` CRD pointing at this repo’s `k8s/overlays/dev` (edit `spec.source.repoURL` + `targetRevision` for your fork). |
| `k8s/base` | Namespace, Deployments, Services — image names and tags are placeholders. |
| `k8s/overlays/dev` | Dev overlay: pins `replicas`, optional image tag via `images` (customize in your fork). |

## Prerequisites

- Cluster with Argo CD installed.
- Container images published for `@growthos/api` and `@growthos/web` (replace `IMAGE_API` / `IMAGE_WEB` in overlays or CI).
- Secrets (database URL, API keys) — **not** committed here; use Sealed Secrets, External Secrets, or Argo CD `Application` helm parameters.

## Apply manually (without Argo)

```bash
kubectl apply -k deploy/gitops/k8s/overlays/dev
```

## Apply via Argo CD

1. Edit `argo-cd/application.yaml`: set `repoURL` to your Git remote and `targetRevision` to a branch or tag.
2. `kubectl apply -f deploy/gitops/argo-cd/application.yaml`

Argo CD will sync the Kustomize overlay path declared in `spec.source.path`.
