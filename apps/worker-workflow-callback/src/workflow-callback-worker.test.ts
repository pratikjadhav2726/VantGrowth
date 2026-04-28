import { InMemoryOutboxRepository } from "@growthos/db";
import { describe, expect, it, vi } from "vitest";
import {
  type EventPublisher,
  WorkflowCallbackWorker,
} from "./workflow-callback-worker.js";

const tenantId = "00000000-0000-4000-8000-000000000001";

describe("WorkflowCallbackWorker", () => {
  it("emits tenant provisioning completed event into outbox and tenant subject", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const eventPublisher: EventPublisher = {
      publish: vi.fn(async () => undefined),
    };
    const worker = new WorkflowCallbackWorker({
      outboxRepository,
      eventPublisher,
    });

    const result = await worker.processTenantProvisioningCompletion({
      tenantId,
      workflowId: "wf-provision-1",
      dedupeKey: "wf-provision-1",
      tenantExternalId: "ten_lat_01",
      tenantName: "Lattice",
      requestedBy: "founder",
    });

    expect(result.status).toBe("accepted");
    expect(eventPublisher.publish).toHaveBeenCalledWith(
      `t.${tenantId}.workflow.tenant_provisioning.completed.v1`,
      expect.objectContaining({
        workflow_id: "wf-provision-1",
        status: "accepted",
      }),
    );

    const events = await outboxRepository.listUnconsumed(tenantId, 10);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe(
      "workflow.tenant_provisioning.completed.v1",
    );
  });

  it("keeps completion outbox idempotent for duplicate requests", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const worker = new WorkflowCallbackWorker({
      outboxRepository,
      eventPublisher: { publish: vi.fn(async () => undefined) },
    });
    const request = {
      tenantId,
      workflowId: "wf-provision-dup",
      dedupeKey: "wf-provision-dup",
      tenantExternalId: "ten_lat_01",
      tenantName: "Lattice",
      requestedBy: "founder",
    };

    await worker.processTenantProvisioningCompletion(request);
    await worker.processTenantProvisioningCompletion(request);

    const events = await outboxRepository.listUnconsumed(tenantId, 10);
    expect(events).toHaveLength(1);
  });
});
