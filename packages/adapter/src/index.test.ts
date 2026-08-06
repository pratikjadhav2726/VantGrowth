import { describe, expect, it, vi } from "vitest";
import {
  GrowthosNativeAdapter,
  type PaperclipAgentCreateInput,
  PaperclipClient,
  type PaperclipCompanyCreateInput,
  type PaperclipIssueCreateInput,
  paperclipConfigFromEnv,
  paperclipWorkReadyEventType,
} from "./index.js";

describe("paperclipConfigFromEnv", () => {
  it("parses valid environment config", () => {
    const config = paperclipConfigFromEnv({
      PAPERCLIP_BASE_URL: "http://localhost:3100",
      PAPERCLIP_SERVICE_TOKEN: "svc_token",
      PAPERCLIP_TIMEOUT_MS: "9000",
    });

    expect(config.baseUrl).toBe("http://localhost:3100");
    expect(config.timeoutMs).toBe(9000);
  });
});

describe("PaperclipClient", () => {
  it("creates company, agent, and issue against Paperclip API shape", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "cmp_1", identifier: "LAT" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "agt_1",
            identifier: "LAT-INB",
            name: "Inbound Strategist",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "iss_1",
            identifier: "LAT-1",
            title: "Draft blog",
            status: "todo",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );

    const client = new PaperclipClient(
      {
        baseUrl: "http://localhost:3100",
        serviceToken: "svc_token",
        timeoutMs: 1000,
      },
      fetchMock,
    );

    const companyInput: PaperclipCompanyCreateInput = {
      externalId: "ten_lat_01",
      name: "Lattice",
    };
    const company = await client.createCompany(companyInput);
    expect(company.id).toBe("cmp_1");

    const agentInput: PaperclipAgentCreateInput = {
      companyId: "cmp_1",
      name: "Inbound Strategist",
      role: "content_strategist",
      title: "Inbound Content Strategist",
      adapterType: "growthos_native",
      budgetMonthlyCents: 4500,
    };
    const agent = await client.createAgent(agentInput);
    expect(agent.id).toBe("agt_1");

    const issueInput: PaperclipIssueCreateInput = {
      companyId: "cmp_1",
      title: "Draft blog",
      assigneeAgentId: "agt_1",
    };
    const issue = await client.createIssue(issueInput);
    expect(issue.identifier).toBe("LAT-1");

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("requeues a failed handoff without invoking the unassigning release endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "iss_1",
          identifier: "ACME-1",
          title: "Prepare account brief",
          status: "todo",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const client = new PaperclipClient(
      {
        baseUrl: "http://localhost:3100",
        serviceToken: "svc_token",
        timeoutMs: 1000,
      },
      fetchMock,
    );

    await client.requeueIssue("iss_1");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3100/api/issues/iss_1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ status: "todo" }),
      }),
    );
  });
});

describe("GrowthosNativeAdapter", () => {
  it("persists a typed, idempotent work-ready handoff", async () => {
    const enqueueOutbox = vi.fn(async () => ({ trackingId: "outbox-42" }));
    const adapter = new GrowthosNativeAdapter({ enqueueOutbox });

    const result = await adapter.emitWorkReady({
      tenantId: "11111111-1111-4111-8111-111111111111",
      paperclipCompanyId: "cmp_1",
      paperclipRunId: "run_1",
      agentId: "agt_1",
      issueId: "iss_1",
      issueIdentifier: "ACME-1",
      issueTitle: "Prepare account brief",
    });

    expect(result).toEqual({ trackingId: "outbox-42" });
    expect(enqueueOutbox).toHaveBeenCalledWith({
      tenantId: "11111111-1111-4111-8111-111111111111",
      eventType: paperclipWorkReadyEventType,
      idempotencyKey: "run_1:work-ready",
      payload: {
        tenant_id: "11111111-1111-4111-8111-111111111111",
        paperclip_company_id: "cmp_1",
        paperclip_run_id: "run_1",
        paperclip_agent_id: "agt_1",
        paperclip_issue_id: "iss_1",
        paperclip_issue_identifier: "ACME-1",
        paperclip_issue_title: "Prepare account brief",
      },
    });
  });
});
