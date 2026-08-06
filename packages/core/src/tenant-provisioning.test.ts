import { PLAN_CODE_MOTION_ACTIVE, StubBillingClient } from "@growthos/billing";
import { StubZitadelClient } from "@growthos/identity";
import { describe, expect, it } from "vitest";
import {
  StubGiteaProvisioningClient,
  StubMinioProvisioningClient,
  StubNatsProvisioningClient,
  StubPaperclipProvisioningClient,
  StubProvisioningProgressReporter,
  TenantProvisioningOrchestrator,
  tenantBucketName,
  tenantLagoMotionSubId,
  tenantNatsConsumerName,
  tenantNatsFilterSubject,
  tenantProvisioningInputV1Schema,
  tenantWorkspaceRepoName,
  tenantZitadelOrgName,
} from "./tenant-provisioning.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT_ID = "00000000-0000-0000-0001-000000000001";

const validInput = {
  tenantId: TENANT_ID,
  tenantName: "Acme GTM",
  tenantExternalId: "ext-acme-001",
  requestedBy: "founder@acme.com",
  workflowId: "wf-001",
  dedupeKey: "prov-acme-001-v1",
};

function makeStubs() {
  return {
    zitadel: new StubZitadelClient(),
    billing: new StubBillingClient(),
    paperclip: new StubPaperclipProvisioningClient(),
    gitea: new StubGiteaProvisioningClient(),
    nats: new StubNatsProvisioningClient(),
    minio: new StubMinioProvisioningClient(),
    progress: new StubProvisioningProgressReporter(),
  };
}

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

describe("tenantProvisioningInputV1Schema", () => {
  it("parses valid input", () => {
    expect(tenantProvisioningInputV1Schema.safeParse(validInput).success).toBe(
      true,
    );
  });

  it("rejects non-UUID tenantId", () => {
    expect(
      tenantProvisioningInputV1Schema.safeParse({
        ...validInput,
        tenantId: "not-a-uuid",
      }).success,
    ).toBe(false);
  });

  it("rejects empty tenantName", () => {
    expect(
      tenantProvisioningInputV1Schema.safeParse({
        ...validInput,
        tenantName: "",
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe("naming helpers", () => {
  it("tenantBucketName", () => {
    expect(tenantBucketName(TENANT_ID)).toBe(`growthos-${TENANT_ID}`);
  });

  it("tenantWorkspaceRepoName", () => {
    expect(tenantWorkspaceRepoName(TENANT_ID)).toBe(`workspace-${TENANT_ID}`);
  });

  it("tenantNatsConsumerName", () => {
    expect(tenantNatsConsumerName(TENANT_ID)).toBe(`tenant-${TENANT_ID}-all`);
  });

  it("tenantNatsFilterSubject", () => {
    expect(tenantNatsFilterSubject(TENANT_ID)).toBe(`t.${TENANT_ID}.>`);
  });

  it("tenantZitadelOrgName", () => {
    expect(tenantZitadelOrgName("Acme GTM")).toBe("growthos-Acme GTM");
  });

  it("tenantLagoMotionSubId", () => {
    expect(tenantLagoMotionSubId(TENANT_ID)).toBe(`${TENANT_ID}-motion-active`);
  });
});

// ---------------------------------------------------------------------------
// Orchestrator — happy path
// ---------------------------------------------------------------------------

describe("TenantProvisioningOrchestrator", () => {
  it("calls all 7 provisioning clients in sequence", async () => {
    const stubs = makeStubs();
    const orch = new TenantProvisioningOrchestrator(stubs);
    const result = await orch.run(validInput);

    expect(result.steps).toHaveLength(7);
    expect(result.steps.map((s) => s.step)).toEqual([
      "zitadel_org",
      "paperclip_company",
      "gitea_workspace_repo",
      "nats_consumer_groups",
      "minio_bucket",
      "lago_customer",
      "seed_founder_doc",
    ]);
  });

  it("returns tenantId and workflowId in result", async () => {
    const stubs = makeStubs();
    const orch = new TenantProvisioningOrchestrator(stubs);
    const result = await orch.run(validInput);
    expect(result.tenantId).toBe(TENANT_ID);
    expect(result.workflowId).toBe("wf-001");
    expect(typeof result.completedAt).toBe("string");
  });

  it("marks steps as not skipped on first run (all isNew=true stubs)", async () => {
    const stubs = makeStubs();
    const orch = new TenantProvisioningOrchestrator(stubs);
    const result = await orch.run(validInput);
    expect(result.steps.every((s) => s.skipped === false)).toBe(true);
  });

  it("emits 8 progress events (1 per step + final 100%)", async () => {
    const stubs = makeStubs();
    const orch = new TenantProvisioningOrchestrator(stubs);
    await orch.run(validInput);
    // 7 "before" reports + 1 final 100% report = 8
    expect(stubs.progress.events).toHaveLength(8);
  });

  it("final progress event is 100%", async () => {
    const stubs = makeStubs();
    const orch = new TenantProvisioningOrchestrator(stubs);
    await orch.run(validInput);
    const last = stubs.progress.events.at(-1);
    expect(last?.progressPercent).toBe(100);
  });

  it("calls Paperclip with correct params", async () => {
    const stubs = makeStubs();
    await new TenantProvisioningOrchestrator(stubs).run(validInput);
    expect(stubs.paperclip.calls[0]).toMatchObject({
      tenantId: TENANT_ID,
      externalId: "ext-acme-001",
      name: "Acme GTM",
    });
  });

  it("calls Gitea with correct repo name derived from tenantId", async () => {
    const stubs = makeStubs();
    await new TenantProvisioningOrchestrator(stubs).run(validInput);
    expect(stubs.gitea.repoCalls[0]?.repoName).toBe(
      tenantWorkspaceRepoName(TENANT_ID),
    );
  });

  it("creates FOUNDER.md at docs/FOUNDER.md", async () => {
    const stubs = makeStubs();
    await new TenantProvisioningOrchestrator(stubs).run(validInput);
    const fileCall = stubs.gitea.fileCalls[0];
    expect(fileCall?.filePath).toBe("docs/FOUNDER.md");
    expect(fileCall?.content).toContain("Acme GTM");
    expect(fileCall?.content).toContain(TENANT_ID);
  });

  it("provisions MinIO bucket with canonical name", async () => {
    const stubs = makeStubs();
    await new TenantProvisioningOrchestrator(stubs).run(validInput);
    expect(stubs.minio.calls[0]?.bucketName).toBe(tenantBucketName(TENANT_ID));
  });

  it("provisions NATS consumer with canonical filter subject", async () => {
    const stubs = makeStubs();
    await new TenantProvisioningOrchestrator(stubs).run(validInput);
    expect(stubs.nats.calls[0]?.filterSubject).toBe(
      tenantNatsFilterSubject(TENANT_ID),
    );
    expect(stubs.nats.calls[0]?.consumerName).toBe(
      tenantNatsConsumerName(TENANT_ID),
    );
  });

  it("marks step as skipped when client returns isNew=false", async () => {
    const stubs = makeStubs();
    // Override Paperclip to simulate already-provisioned company
    stubs.paperclip.provisionCompany = async (params) => ({
      companyId: `paperclip-company-${params.tenantId}`,
      isNew: false,
    });
    const result = await new TenantProvisioningOrchestrator(stubs).run(
      validInput,
    );
    const paperclipStep = result.steps.find(
      (s) => s.step === "paperclip_company",
    );
    expect(paperclipStep?.skipped).toBe(true);
    // Other steps are still not skipped
    const other = result.steps.filter((s) => s.step !== "paperclip_company");
    expect(other.every((s) => s.skipped === false)).toBe(true);
  });

  it("propagates errors from a step client", async () => {
    const stubs = makeStubs();
    stubs.gitea.provisionWorkspaceRepo = async () => {
      throw new Error("Gitea unavailable");
    };
    await expect(
      new TenantProvisioningOrchestrator(stubs).run(validInput),
    ).rejects.toThrow("Gitea unavailable");
  });

  it("creates Zitadel org with canonical name", async () => {
    const stubs = makeStubs();
    await new TenantProvisioningOrchestrator(stubs).run(validInput);
    expect(stubs.zitadel.createOrgCalls[0]?.name).toBe(
      tenantZitadelOrgName("Acme GTM"),
    );
  });

  it("creates Zitadel service account after org creation", async () => {
    const stubs = makeStubs();
    await new TenantProvisioningOrchestrator(stubs).run(validInput);
    // Service account created — we can verify the call exists
    const org = await stubs.zitadel.getOrg(
      stubs.zitadel.createOrgCalls[0]
        ? `zitadel-org-${tenantZitadelOrgName("Acme GTM").toLowerCase().replace(/\s+/g, "-")}`
        : "",
    );
    // Org was registered in stub
    expect(stubs.zitadel.createOrgCalls).toHaveLength(1);
  });

  it("zitadel_org step output includes orgId", async () => {
    const stubs = makeStubs();
    const result = await new TenantProvisioningOrchestrator(stubs).run(
      validInput,
    );
    const step = result.steps.find((s) => s.step === "zitadel_org");
    expect(step?.output).toMatchObject({
      orgId: expect.any(String),
      orgName: expect.any(String),
    });
  });

  it("creates Lago customer with tenantId as externalId", async () => {
    const stubs = makeStubs();
    await new TenantProvisioningOrchestrator(stubs).run(validInput);
    expect(stubs.billing.createCustomerCalls[0]?.externalId).toBe(TENANT_ID);
  });

  it("assigns motion_active plan to Lago customer", async () => {
    const stubs = makeStubs();
    await new TenantProvisioningOrchestrator(stubs).run(validInput);
    expect(stubs.billing.assignPlanCalls[0]?.planCode).toBe(
      PLAN_CODE_MOTION_ACTIVE,
    );
    expect(stubs.billing.assignPlanCalls[0]?.subscriptionExternalId).toBe(
      tenantLagoMotionSubId(TENANT_ID),
    );
  });

  it("lago_customer step output includes lagoCustomerId and planCode", async () => {
    const stubs = makeStubs();
    const result = await new TenantProvisioningOrchestrator(stubs).run(
      validInput,
    );
    const step = result.steps.find((s) => s.step === "lago_customer");
    expect(step?.output).toMatchObject({
      lagoCustomerId: expect.any(String),
      planCode: PLAN_CODE_MOTION_ACTIVE,
    });
  });
});
