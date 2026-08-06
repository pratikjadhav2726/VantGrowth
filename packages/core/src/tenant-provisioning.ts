/**
 * Tenant provisioning workflow executor — Phase 1 / S1
 *
 * Implements the idempotent, step-by-step provisioning sequence that
 * creates all per-tenant resources when a new founder onboards:
 *
 *   1. Provision Paperclip company
 *   2. Provision Gitea workspace repository (from growthos-ws-template)
 *   3. Provision NATS consumer groups (per-tenant subject namespace)
 *   4. Provision MinIO bucket (growthos-{tenantId})
 *   5. Seed workspace with FOUNDER.md
 *
 * Each step emits a progress event through the supplied `ProgressReporter`
 * so the outbox → NATS pipeline carries live state to any listener.
 *
 * Design principles:
 *   - All external interactions go through typed client interfaces so the
 *     orchestrator is fully testable with stubs.
 *   - Each step is idempotent: calling it twice with the same input is safe.
 *   - The orchestrator does not own the Postgres transaction or NATS publish;
 *     it delegates side-effects to the injected clients and reporter.
 *   - When wired with Restate, the orchestrator becomes the durable step body
 *     inside a `ctx.run(...)` block — no Restate SDK leaks into this module.
 */

import type { BillingClient, PlanCode } from "@growthos/billing";
import { PLAN_CODE_MOTION_ACTIVE } from "@growthos/billing";
import type { ZitadelClient, ZitadelOrg } from "@growthos/identity";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Input / output schemas
// ---------------------------------------------------------------------------

export const tenantProvisioningInputV1Schema = z.object({
  tenantId: z.string().uuid(),
  tenantName: z.string().min(1).max(128),
  tenantExternalId: z.string().min(1),
  requestedBy: z.string().min(1),
  workflowId: z.string().min(1),
  dedupeKey: z.string().min(1),
});

export type TenantProvisioningInputV1 = z.infer<
  typeof tenantProvisioningInputV1Schema
>;

export const provisioningStepSchema = z.enum([
  "zitadel_org",
  "paperclip_company",
  "gitea_workspace_repo",
  "nats_consumer_groups",
  "minio_bucket",
  "lago_customer",
  "seed_founder_doc",
]);
export type ProvisioningStep = z.infer<typeof provisioningStepSchema>;

export interface ProvisioningStepResult<T = Record<string, unknown>> {
  step: ProvisioningStep;
  skipped: boolean;
  output: T;
}

export interface TenantProvisioningResult {
  tenantId: string;
  workflowId: string;
  steps: ProvisioningStepResult[];
  completedAt: string;
}

// ---------------------------------------------------------------------------
// Typed client interfaces — one per external system
// Each method must be idempotent (safe to call multiple times).
// ---------------------------------------------------------------------------

export interface PaperclipProvisioningClient {
  /**
   * Creates a Paperclip company for the tenant.
   * Idempotent: returns the existing company if already created.
   */
  provisionCompany(params: {
    tenantId: string;
    externalId: string;
    name: string;
  }): Promise<{ companyId: string; isNew: boolean }>;
}

export interface GiteaProvisioningClient {
  /**
   * Creates a workspace repository for the tenant from the template.
   * Idempotent: returns the existing repo URL if already created.
   */
  provisionWorkspaceRepo(params: {
    tenantId: string;
    templateRepo: string;
    repoName: string;
  }): Promise<{ repoUrl: string; isNew: boolean }>;

  /**
   * Creates or replaces a file in the workspace repository.
   * Idempotent: uses a SHA-based upsert.
   */
  createOrUpdateFile(params: {
    tenantId: string;
    repoName: string;
    filePath: string;
    content: string;
    commitMessage: string;
  }): Promise<{ sha: string; isNew: boolean }>;
}

export interface NatsProvisioningClient {
  /**
   * Creates the per-tenant NATS consumer group on the GROWTHOS stream.
   * Idempotent: is a no-op if the consumer already exists.
   */
  provisionConsumerGroup(params: {
    tenantId: string;
    filterSubject: string;
    consumerName: string;
  }): Promise<{ consumerName: string; isNew: boolean }>;
}

export interface MinioProvisioningClient {
  /**
   * Creates the per-tenant MinIO bucket.
   * Idempotent: is a no-op if the bucket already exists.
   */
  provisionBucket(params: {
    bucketName: string;
    tenantId: string;
  }): Promise<{ bucketName: string; isNew: boolean }>;
}

/** Emits a progress event for the current workflow run. */
export interface ProvisioningProgressReporter {
  report(params: {
    step: ProvisioningStep;
    progressPercent: number;
    message: string;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface TenantProvisioningClients {
  zitadel: ZitadelClient;
  billing: BillingClient;
  paperclip: PaperclipProvisioningClient;
  gitea: GiteaProvisioningClient;
  nats: NatsProvisioningClient;
  minio: MinioProvisioningClient;
  progress: ProvisioningProgressReporter;
}

/** Canonical MinIO bucket name for a tenant. */
export const tenantBucketName = (tenantId: string): string =>
  `growthos-${tenantId}`;

/** Canonical Gitea workspace repo name for a tenant. */
export const tenantWorkspaceRepoName = (tenantId: string): string =>
  `workspace-${tenantId}`;

/** NATS consumer name for the tenant's subject namespace. */
export const tenantNatsConsumerName = (tenantId: string): string =>
  `tenant-${tenantId}-all`;

/** NATS filter subject for all events belonging to a tenant. */
export const tenantNatsFilterSubject = (tenantId: string): string =>
  `t.${tenantId}.>`;

/** Zitadel org name for a tenant. */
export const tenantZitadelOrgName = (tenantName: string): string =>
  `growthos-${tenantName}`;

/** Lago external customer ID for a tenant (= tenantId). */
export const tenantLagoCustomerId = (tenantId: string): string => tenantId;

/** Lago external subscription ID for the motion-active plan. */
export const tenantLagoMotionSubId = (tenantId: string): string =>
  `${tenantId}-motion-active`;

const FOUNDER_MD_TEMPLATE = (tenantName: string, tenantId: string): string =>
  `# ${tenantName} — GrowthOS Workspace

Tenant ID: \`${tenantId}\`

## Mission

This repository is the working memory for your GrowthOS agents. Skills, playbooks,
brand context, and approved content live here. Agents read from and write to this
workspace under your direction.

## Directory structure

\`\`\`
docs/
  FOUNDER.md        — this file (founder profile + brand context)
  brand_rules.md    — positioning rules, approved stats, competitor notes
skills/             — tenant-specific skill overrides (optional)
content/            — approved drafts, published pieces
intel/              — weekly intelligence briefs
\`\`\`

## Founder profile

<!-- Fill in: your name, role, preferred communication style, vocabulary to use/avoid -->

## Brand context

<!-- Fill in: one-sentence positioning, ICP description, top 3 proof points, approved stats -->

## Setup checklist

- [ ] Complete the Founder profile section
- [ ] Complete the Brand context section
- [ ] Run motion scoring: \`POST /v1/motions/score\` with your company signals
- [ ] Review and approve your motion stack
`;

export class TenantProvisioningOrchestrator {
  constructor(private readonly clients: TenantProvisioningClients) {}

  async run(
    input: TenantProvisioningInputV1,
  ): Promise<TenantProvisioningResult> {
    const parsed = tenantProvisioningInputV1Schema.parse(input);
    const steps: ProvisioningStepResult[] = [];

    // ── Step 0: Zitadel org ────────────────────────────────────────────────
    await this.clients.progress.report({
      step: "zitadel_org",
      progressPercent: 5,
      message: `Provisioning Zitadel organisation for ${parsed.tenantName}`,
    });
    const org = await this.clients.zitadel.createOrg({
      name: tenantZitadelOrgName(parsed.tenantName),
    });
    await this.clients.zitadel.createServiceAccount({
      orgId: org.orgId,
      userName: "growthos-api",
      displayName: "GrowthOS API Service Account",
    });
    steps.push({
      step: "zitadel_org",
      skipped: false,
      output: { orgId: org.orgId, orgName: org.name },
    });

    // ── Step 1: Paperclip company ──────────────────────────────────────────
    await this.clients.progress.report({
      step: "paperclip_company",
      progressPercent: 15,
      message: `Provisioning Paperclip company for ${parsed.tenantName}`,
    });
    const companyResult = await this.clients.paperclip.provisionCompany({
      tenantId: parsed.tenantId,
      externalId: parsed.tenantExternalId,
      name: parsed.tenantName,
    });
    steps.push({
      step: "paperclip_company",
      skipped: !companyResult.isNew,
      output: { companyId: companyResult.companyId },
    });

    // ── Step 2: Gitea workspace repo ───────────────────────────────────────
    await this.clients.progress.report({
      step: "gitea_workspace_repo",
      progressPercent: 35,
      message: `Provisioning workspace repository for tenant ${parsed.tenantId}`,
    });
    const repoResult = await this.clients.gitea.provisionWorkspaceRepo({
      tenantId: parsed.tenantId,
      templateRepo: "growthos-ws-template",
      repoName: tenantWorkspaceRepoName(parsed.tenantId),
    });
    steps.push({
      step: "gitea_workspace_repo",
      skipped: !repoResult.isNew,
      output: { repoUrl: repoResult.repoUrl },
    });

    // ── Step 3: NATS consumer groups ───────────────────────────────────────
    await this.clients.progress.report({
      step: "nats_consumer_groups",
      progressPercent: 52,
      message: `Provisioning NATS consumer group for tenant ${parsed.tenantId}`,
    });
    const natsResult = await this.clients.nats.provisionConsumerGroup({
      tenantId: parsed.tenantId,
      filterSubject: tenantNatsFilterSubject(parsed.tenantId),
      consumerName: tenantNatsConsumerName(parsed.tenantId),
    });
    steps.push({
      step: "nats_consumer_groups",
      skipped: !natsResult.isNew,
      output: { consumerName: natsResult.consumerName },
    });

    // ── Step 4: MinIO bucket ───────────────────────────────────────────────
    await this.clients.progress.report({
      step: "minio_bucket",
      progressPercent: 67,
      message: `Provisioning MinIO bucket ${tenantBucketName(parsed.tenantId)}`,
    });
    const bucketResult = await this.clients.minio.provisionBucket({
      bucketName: tenantBucketName(parsed.tenantId),
      tenantId: parsed.tenantId,
    });
    steps.push({
      step: "minio_bucket",
      skipped: !bucketResult.isNew,
      output: { bucketName: bucketResult.bucketName },
    });

    // ── Step 5: Lago billing customer ─────────────────────────────────────
    await this.clients.progress.report({
      step: "lago_customer",
      progressPercent: 80,
      message: `Provisioning Lago billing customer for tenant ${parsed.tenantId}`,
    });
    const lagoCustomer = await this.clients.billing.createCustomer({
      externalId: tenantLagoCustomerId(parsed.tenantId),
      name: parsed.tenantName,
    });
    const lagoSub = await this.clients.billing.assignPlan({
      customerExternalId: tenantLagoCustomerId(parsed.tenantId),
      planCode: PLAN_CODE_MOTION_ACTIVE,
      subscriptionExternalId: tenantLagoMotionSubId(parsed.tenantId),
    });
    steps.push({
      step: "lago_customer",
      skipped: false,
      output: {
        lagoCustomerId: lagoCustomer.lagoId,
        subscriptionId: lagoSub.lagoId,
        planCode: lagoSub.planCode,
      },
    });

    // ── Step 6: Seed FOUNDER.md ────────────────────────────────────────────
    await this.clients.progress.report({
      step: "seed_founder_doc",
      progressPercent: 90,
      message: "Seeding FOUNDER.md in workspace repository",
    });
    const fileResult = await this.clients.gitea.createOrUpdateFile({
      tenantId: parsed.tenantId,
      repoName: tenantWorkspaceRepoName(parsed.tenantId),
      filePath: "docs/FOUNDER.md",
      content: FOUNDER_MD_TEMPLATE(parsed.tenantName, parsed.tenantId),
      commitMessage: "chore: seed FOUNDER.md from GrowthOS template",
    });
    steps.push({
      step: "seed_founder_doc",
      skipped: !fileResult.isNew,
      output: { sha: fileResult.sha },
    });

    await this.clients.progress.report({
      step: "seed_founder_doc",
      progressPercent: 100,
      message: `Tenant ${parsed.tenantName} provisioned successfully`,
    });

    return {
      tenantId: parsed.tenantId,
      workflowId: parsed.workflowId,
      steps,
      completedAt: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Stub implementations — used in tests and local dev (not production)
// ---------------------------------------------------------------------------

export class StubPaperclipProvisioningClient
  implements PaperclipProvisioningClient
{
  readonly calls: Parameters<
    PaperclipProvisioningClient["provisionCompany"]
  >[0][] = [];

  async provisionCompany(
    params: Parameters<PaperclipProvisioningClient["provisionCompany"]>[0],
  ) {
    this.calls.push(params);
    return {
      companyId: `paperclip-company-${params.tenantId}`,
      isNew: true,
    };
  }
}

export class StubGiteaProvisioningClient implements GiteaProvisioningClient {
  readonly repoCalls: Parameters<
    GiteaProvisioningClient["provisionWorkspaceRepo"]
  >[0][] = [];
  readonly fileCalls: Parameters<
    GiteaProvisioningClient["createOrUpdateFile"]
  >[0][] = [];

  async provisionWorkspaceRepo(
    params: Parameters<GiteaProvisioningClient["provisionWorkspaceRepo"]>[0],
  ) {
    this.repoCalls.push(params);
    return {
      repoUrl: `https://gitea.local/${params.tenantId}/${params.repoName}`,
      isNew: true,
    };
  }

  async createOrUpdateFile(
    params: Parameters<GiteaProvisioningClient["createOrUpdateFile"]>[0],
  ) {
    this.fileCalls.push(params);
    return { sha: `sha-${params.filePath}`, isNew: true };
  }
}

export class StubNatsProvisioningClient implements NatsProvisioningClient {
  readonly calls: Parameters<
    NatsProvisioningClient["provisionConsumerGroup"]
  >[0][] = [];

  async provisionConsumerGroup(
    params: Parameters<NatsProvisioningClient["provisionConsumerGroup"]>[0],
  ) {
    this.calls.push(params);
    return { consumerName: params.consumerName, isNew: true };
  }
}

export class StubMinioProvisioningClient implements MinioProvisioningClient {
  readonly calls: Parameters<MinioProvisioningClient["provisionBucket"]>[0][] =
    [];

  async provisionBucket(
    params: Parameters<MinioProvisioningClient["provisionBucket"]>[0],
  ) {
    this.calls.push(params);
    return { bucketName: params.bucketName, isNew: true };
  }
}

export class StubProvisioningProgressReporter
  implements ProvisioningProgressReporter
{
  readonly events: Parameters<ProvisioningProgressReporter["report"]>[0][] = [];

  async report(params: Parameters<ProvisioningProgressReporter["report"]>[0]) {
    this.events.push(params);
  }
}
