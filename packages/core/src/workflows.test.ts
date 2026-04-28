import { describe, expect, it } from "vitest";
import {
  acceptTenantProvisioningWorkflowDeterministic,
  createRestateHelloWorkflowOutboxCommand,
  createTenantProvisioningWorkflowOutboxCommand,
  runHelloWorkflowDeterministic,
} from "./workflows.js";

const tenantId = "00000000-0000-4000-8000-000000000001";

describe("restate workflow starter contracts", () => {
  it("creates hello workflow outbox command shape", () => {
    const command = createRestateHelloWorkflowOutboxCommand({
      tenantId,
      workflowId: "wf-hello-1",
      dedupeKey: "wf-hello-1",
      initiatedBy: "founder",
      message: "bootstrap tenant checks",
    });

    expect(command.eventType).toBe("workflow.hello.requested.v1");
    expect(command.tenantId).toBe(tenantId);
    expect(command.payload).toMatchObject({
      workflow_id: "wf-hello-1",
      initiated_by: "founder",
    });
  });

  it("returns deterministic hello workflow result contract", () => {
    const result = runHelloWorkflowDeterministic({
      tenantId,
      workflowId: "wf-hello-1",
      dedupeKey: "wf-hello-1",
      initiatedBy: "founder",
      message: "bootstrap tenant checks",
    });

    expect(result.status).toBe("completed");
    expect(result.responseMessage).toContain("Hello founder");
  });

  it("creates tenant provisioning outbox command shape", () => {
    const command = createTenantProvisioningWorkflowOutboxCommand({
      tenantId,
      workflowId: "wf-provision-1",
      dedupeKey: "wf-provision-1",
      tenantExternalId: "ten_lat_01",
      tenantName: "Lattice",
      requestedBy: "founder",
    });

    expect(command.eventType).toBe("workflow.tenant_provisioning.requested.v1");
    expect(command.payload).toMatchObject({
      workflow_id: "wf-provision-1",
      tenant_external_id: "ten_lat_01",
    });
  });

  it("returns deterministic tenant provisioning accepted contract", () => {
    const result = acceptTenantProvisioningWorkflowDeterministic({
      tenantId,
      workflowId: "wf-provision-1",
      dedupeKey: "wf-provision-1",
      tenantExternalId: "ten_lat_01",
      tenantName: "Lattice",
      requestedBy: "founder",
    });

    expect(result.status).toBe("accepted");
    expect(result.provisioningKey).toContain("ten_lat_01");
  });
});
