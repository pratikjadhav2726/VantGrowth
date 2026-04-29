# Dev overlay + GHCR pull secrets

Same as [`../dev`](../dev/) (Kustomize `environment: dev` label) plus the same **strategic-merge patches** as [`../with-ghcr-pull`](../with-ghcr-pull/) (`imagePullSecrets: ghcr-pull` on API + web).

Patch YAML files are **duplicated** here (not symlinked) because `kubectl kustomize` requires patch paths to stay inside this directory.

Create Secret `ghcr-pull` first — see [`../with-ghcr-pull/README.md`](../with-ghcr-pull/README.md).

```bash
kubectl apply -k deploy/gitops/k8s/overlays/dev-with-ghcr-pull
```
