# Pulumi stub — GrowthOS infrastructure

This folder is a **minimal Pulumi TypeScript program** you can extend to provision cloud resources (VPC, RDS, managed K8s, secrets) alongside the GitOps manifests in [`../gitops/`](../gitops/).

## Setup

```bash
cd deploy/pulumi
npm install
pulumi login # or use local backend: pulumi login --local
pulumi stack init dev
pulumi preview
```

## What it does today

Exports a placeholder stack output so CI or humans can verify `pulumi preview` wiring before real resources are added.

Replace `index.ts` with your cloud provider SDK (`@pulumi/aws`, `@pulumi/azure-native`, etc.) when you are ready to allocate infrastructure.
