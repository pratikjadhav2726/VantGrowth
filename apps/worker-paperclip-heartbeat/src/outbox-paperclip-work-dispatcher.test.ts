import { paperclipWorkReadyEventType } from "@growthos/adapter";
import { InMemoryOutboxRepository } from "@growthos/db";
import { describe, expect, it } from "vitest";
import { OutboxPaperclipWorkDispatcher } from "./outbox-paperclip-work-dispatcher.js";

const tenantId = "11111111-1111-4111-8111-111111111111";

describe("OutboxPaperclipWorkDispatcher", () => {
  it("persists one tenant-scoped handoff for retries of the same Paperclip run", async () => {
    const outbox = new InMemoryOutboxRepository();
    const dispatcher = new OutboxPaperclipWorkDispatcher(outbox);
    const context = {
      tenantId,
      companyId: "cmp_1",
      agentId: "agt_1",
      issueId: "iss_1",
      issueIdentifier: "ACME-1",
      title: "Prepare account brief",
      runId: "run_1",
    };

    await dispatcher.dispatch(context);
    await dispatcher.dispatch(context);
    const pending = await outbox.listUnconsumed(tenantId, 10);

    expect(pending).toEqual([
      expect.objectContaining({
        tenantId,
        eventType: paperclipWorkReadyEventType,
        idempotencyKey: "run_1:work-ready",
        payload: {
          tenant_id: tenantId,
          paperclip_company_id: "cmp_1",
          paperclip_run_id: "run_1",
          paperclip_agent_id: "agt_1",
          paperclip_issue_id: "iss_1",
          paperclip_issue_identifier: "ACME-1",
          paperclip_issue_title: "Prepare account brief",
        },
      }),
    ]);
  });
});
