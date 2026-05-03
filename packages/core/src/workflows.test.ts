import { describe, expect, it } from "vitest";
import {
  acceptTenantProvisioningWorkflowDeterministic,
  createRestateHelloWorkflowOutboxCommand,
  createTenantProvisioningCompletedOutboxCommand,
  createTenantProvisioningFailedOutboxCommand,
  createTenantProvisioningProgressOutboxCommand,
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

  it("creates tenant provisioning completed outbox command shape", () => {
    const command = createTenantProvisioningCompletedOutboxCommand({
      tenantId,
      workflowId: "wf-provision-1",
      dedupeKey: "wf-provision-1",
      tenantExternalId: "ten_lat_01",
      tenantName: "Lattice",
      requestedBy: "founder",
      callbackId: "cb-1",
      runtimeRunId: "run-1",
    });

    expect(command.eventType).toBe("workflow.tenant_provisioning.completed.v1");
    expect(command.idempotencyKey).toContain("cb-1");
    expect(command.payload).toMatchObject({
      callback_id: "cb-1",
      runtime_run_id: "run-1",
      status: "accepted",
    });
  });

  it("creates tenant provisioning progress outbox command shape", () => {
    const command = createTenantProvisioningProgressOutboxCommand({
      tenantId,
      workflowId: "wf-provision-1",
      dedupeKey: "wf-provision-1",
      tenantExternalId: "ten_lat_01",
      tenantName: "Lattice",
      requestedBy: "founder",
      callbackId: "cb-1",
      runtimeRunId: "run-1",
      callbackType: "progress",
      progressStep: "paperclip.company.created",
      progressMessage: "Paperclip company created",
      progressPercent: 25,
    });

    expect(command.eventType).toBe("workflow.tenant_provisioning.progress.v1");
    expect(command.payload).toMatchObject({
      progress_step: "paperclip.company.created",
      progress_message: "Paperclip company created",
      progress_percent: 25,
      callback_type: "progress",
    });
  });

  it("creates tenant provisioning failed outbox command shape", () => {
    const command = createTenantProvisioningFailedOutboxCommand({
      tenantId,
      workflowId: "wf-provision-1",
      dedupeKey: "wf-provision-1",
      tenantExternalId: "ten_lat_01",
      tenantName: "Lattice",
      requestedBy: "founder",
      callbackId: "cb-fail-1",
      runtimeRunId: "run-1",
      callbackType: "failed",
      failureCode: "PROVISIONING_TIMEOUT",
      failureMessage: "Provisioning timed out after 60s",
    });

    expect(command.eventType).toBe("workflow.tenant_provisioning.failed.v1");
    expect(command.idempotencyKey).toContain("cb-fail-1");
    expect(command.idempotencyKey).toContain("failed");
    expect(command.payload).toMatchObject({
      failure_code: "PROVISIONING_TIMEOUT",
      failure_message: "Provisioning timed out after 60s",
      callback_id: "cb-fail-1",
      runtime_run_id: "run-1",
    });
  });

  it("defaults callbackType to completed when not provided", () => {
    const command = createTenantProvisioningCompletedOutboxCommand({
      tenantId,
      workflowId: "wf-provision-1",
      dedupeKey: "wf-provision-1",
      tenantExternalId: "ten_lat_01",
      tenantName: "Lattice",
      requestedBy: "founder",
      callbackId: "cb-1",
    });

    expect(command.eventType).toBe("workflow.tenant_provisioning.completed.v1");
  });
});
