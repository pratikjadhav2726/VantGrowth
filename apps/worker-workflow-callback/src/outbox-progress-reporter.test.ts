import { InMemoryOutboxRepository } from "@growthos/db";
import { describe, expect, it } from "vitest";
import { OutboxProvisioningProgressReporter } from "./outbox-progress-reporter.js";

const tenantId = "00000000-0000-4000-8000-000000000001";

describe("OutboxProvisioningProgressReporter", () => {
  it("writes idempotent progress lifecycle events without a direct publisher", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const reporter = new OutboxProvisioningProgressReporter(outboxRepository, {
      tenantId,
      workflowId: "wf-provision-1",
      dedupeKey: "wf-provision-1",
      tenantExternalId: "ten_acme_01",
      tenantName: "Acme",
      requestedBy: "founder",
    });

    await reporter.report({
      step: "paperclip_company",
      progressPercent: 35,
      message: "Paperclip company provisioned",
    });
    await reporter.report({
      step: "paperclip_company",
      progressPercent: 35,
      message: "Paperclip company provisioned",
    });

    expect(await outboxRepository.listUnconsumed(tenantId, 10)).toEqual([
      expect.objectContaining({
        eventType: "workflow.tenant_provisioning.progress.v1",
        idempotencyKey:
          "wf-provision-1:progress:orchestrator:wf-provision-1:paperclip_company:35:paperclip_company",
        payload: expect.objectContaining({
          workflow_id: "wf-provision-1",
          progress_step: "paperclip_company",
          progress_percent: 35,
        }),
      }),
    ]);
  });
});
