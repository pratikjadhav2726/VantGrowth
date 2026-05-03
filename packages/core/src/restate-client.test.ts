import { describe, expect, it, vi } from "vitest";
import {
  RestateHttpWorkflowClient,
  restateConfigFromEnv,
} from "./restate-client.js";

const tenantId = "00000000-0000-4000-8000-000000000001";

describe("restateConfigFromEnv", () => {
  it("returns null when RESTATE_BASE_URL is absent", () => {
    expect(restateConfigFromEnv({})).toBeNull();
  });
});

describe("RestateHttpWorkflowClient", () => {
  it("posts hello workflow start request", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 202 }));
    const client = new RestateHttpWorkflowClient(
      {
        baseUrl: "http://localhost:8080",
        timeoutMs: 1000,
      },
      fetchMock,
    );

    await client.startHelloWorkflow({
      tenantId,
      workflowId: "wf-hello-1",
      dedupeKey: "wf-hello-1",
      initiatedBy: "founder",
      message: "hello",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8080/workflows/hello",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("posts tenant provisioning workflow start request", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 202 }));
    const client = new RestateHttpWorkflowClient(
      {
        baseUrl: "http://localhost:8080",
        timeoutMs: 1000,
      },
      fetchMock,
    );

    await client.startTenantProvisioningWorkflow({
      tenantId,
      workflowId: "wf-provision-1",
      dedupeKey: "wf-provision-1",
      tenantExternalId: "ten_lat_01",
      tenantName: "Lattice",
      requestedBy: "founder",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8080/workflows/tenant-provisioning",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("fetches tenant provisioning runtime state with history", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          workflowId: "wf-provision-1",
          tenantId,
          runtimeRunId: "run-1",
          state: "completed",
          history: [
            {
              step: "paperclip.company.created",
              message: "Paperclip company created",
              percent: 25,
              occurredAt: "2026-04-28T00:00:00.000Z",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new RestateHttpWorkflowClient(
      {
        baseUrl: "http://localhost:8080",
        timeoutMs: 1000,
      },
      fetchMock,
    );

    const state = await client.getTenantProvisioningRuntimeState({
      tenantId,
      workflowId: "wf-provision-1",
    });

    expect(state.state).toBe("completed");
    expect(state.history).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8080/workflows/tenant-provisioning/wf-provision-1/state?tenantId=00000000-0000-4000-8000-000000000001",
      expect.objectContaining({ method: "GET" }),
    );
  });
});
