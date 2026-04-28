import { describe, expect, it } from "vitest";
import {
  StubGiteaProvisioningClient,
  StubMinioProvisioningClient,
  StubNatsProvisioningClient,
  StubPaperclipProvisioningClient,
  StubProvisioningProgressReporter,
  TenantProvisioningOrchestrator,
  tenantBucketName,
  tenantNatsConsumerName,
  tenantNatsFilterSubject,
  tenantProvisioningInputV1Schema,
  tenantWorkspaceRepoName,
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
});

// ---------------------------------------------------------------------------
// Orchestrator — happy path
// ---------------------------------------------------------------------------

describe("TenantProvisioningOrchestrator", () => {
  it("calls all 5 provisioning clients in sequence", async () => {
    const stubs = makeStubs();
    const orch = new TenantProvisioningOrchestrator(stubs);
    const result = await orch.run(validInput);

    expect(result.steps).toHaveLength(5);
    expect(result.steps.map((s) => s.step)).toEqual([
      "paperclip_company",
      "gitea_workspace_repo",
      "nats_consumer_groups",
      "minio_bucket",
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

  it("emits 6 progress events (1 per step + final 100%)", async () => {
    const stubs = makeStubs();
    const orch = new TenantProvisioningOrchestrator(stubs);
    await orch.run(validInput);
    // 5 "before" reports + 1 final 100% report = 6
    expect(stubs.progress.events).toHaveLength(6);
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
});
