import { InMemoryOutboxRepository } from "@growthos/db";
import { describe, expect, it } from "vitest";
import {
  enqueueWorkflowCallbackDeadLetter,
  parseTenantProvisioningRequestedEvent,
  tenantIdFromTenantScopedSubject,
} from "./tenant-provisioning-request.js";

const tenantId = "00000000-0000-4000-8000-000000000001";
const subject = `t.${tenantId}.workflow.tenant_provisioning.requested.v1`;

describe("tenant provisioning durable-consumer contracts", () => {
  it("normalizes the outbox's snake_case request using the subject tenant", () => {
    expect(
      parseTenantProvisioningRequestedEvent(
        {
          workflow_id: "wf-provision-1",
          tenant_external_id: "ten_acme_01",
          tenant_name: "Acme",
          requested_by: "founder",
        },
        subject,
      ),
    ).toEqual({
      tenantId,
      workflowId: "wf-provision-1",
      dedupeKey: "wf-provision-1",
      tenantExternalId: "ten_acme_01",
      tenantName: "Acme",
      requestedBy: "founder",
    });
  });

  it("rejects a canonical payload that tries to cross tenant boundaries", () => {
    expect(() =>
      parseTenantProvisioningRequestedEvent(
        {
          tenantId: "00000000-0000-4000-8000-000000000002",
          workflowId: "wf-provision-1",
          dedupeKey: "wf-provision-1",
          tenantExternalId: "ten_acme_01",
          tenantName: "Acme",
          requestedBy: "founder",
        },
        subject,
      ),
    ).toThrow("does not match subject");
  });

  it("rejects invalid tenant-scoped subjects before an outbox write", () => {
    expect(() =>
      tenantIdFromTenantScopedSubject("workflow.requested.v1"),
    ).toThrow("Invalid tenant-scoped workflow subject");
  });

  it("persists an exhausted delivery as a deterministic outbox dead letter", async () => {
    const outboxRepository = new InMemoryOutboxRepository();

    await enqueueWorkflowCallbackDeadLetter(
      outboxRepository,
      { workflow_id: "wf-provision-1" },
      {
        subject,
        streamSequence: 42,
        redeliveryCount: 5,
      },
      new Error("runtime unavailable"),
    );

    expect(await outboxRepository.listUnconsumed(tenantId, 10)).toEqual([
      expect.objectContaining({
        eventType: "worker.dead_lettered.v1",
        idempotencyKey: "workflow-callback:42",
        payload: expect.objectContaining({
          worker: "workflow_callback",
          source_subject: subject,
          stream_sequence: 42,
          redelivery_count: 5,
          error: "runtime unavailable",
        }),
      }),
    ]);
  });
});
