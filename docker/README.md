# Container images (GHCR)

Production images for the GrowthOS monorepo:

| Image | Dockerfile | Default command |
|-------|------------|-----------------|
| `growthos-api` | [`api.Dockerfile`](./api.Dockerfile) | `node dist/index.js` (port **3001**) |
| `growthos-web` | [`web.Dockerfile`](./web.Dockerfile) | Next.js **standalone** (port **3000**) |

## Build locally

```bash
# API
docker build -f docker/api.Dockerfile -t growthos-api:local .

# Web (Next standalone)
docker build -f docker/web.Dockerfile -t growthos-web:local .
```

## CI

On push to `main` / `master`, [`.github/workflows/container-images.yml`](../.github/workflows/container-images.yml) builds and pushes to **GitHub Container Registry**:

`ghcr.io/<lowercase-owner>/growthos-api:<sha>` and `growthos-web` with the same tags plus `:latest`.

Set image tags in your GitOps overlay (see [`deploy/gitops/k8s/overlays/dev/kustomization.yaml`](../deploy/gitops/k8s/overlays/dev/kustomization.yaml)).

## Runtime configuration

- **API**: set `DATABASE_URL` and other secrets via Kubernetes `Secret` referenced in `envFrom` (see [`deploy/gitops/k8s/README-secrets.md`](../deploy/gitops/k8s/README-secrets.md)).
- **Web**: set `GROWTHOS_API_BASE_URL` to the in-cluster API Service URL (already defaulted in the GitOps base manifest).
