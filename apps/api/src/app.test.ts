import { createHmac } from "node:crypto";
import { PaperclipClient, type PaperclipClientPort } from "@growthos/adapter";
import type { RestateWorkflowClientPort } from "@growthos/core";
import {
  InMemoryApprovalFeedbackRepository,
  InMemoryMotionStackRepository,
  InMemoryOutboxRepository,
  InMemorySignalEventsRepository,
  InMemoryWorkflowRunRepository,
} from "@growthos/db";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";

const tenantId = "00000000-0000-4000-8000-000000000001";

describe("API app", () => {
  it("returns health status", async () => {
    const app = createApp();
    const response = await app.request("http://localhost/health");
    expect(response.status).toBe(200);
  });

  it("scores motions (legacy inline handler removed — covered by POST /v1/motions suite)", () => {
    // The inline POST /v1/motions/score was replaced by createMotionsRoutes
    // which persists scores and returns 201. See the POST /v1/motions suite.
    expect(true).toBe(true);
  });

  it("persists outbox commands through the configured repository", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const app = createApp({ outboxRepository });

    const response = await app.request("http://localhost/v1/commands/outbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tenantId,
        eventType: "tenant.created.v1",
        idempotencyKey: "tenant-created-1",
        payload: { plan: "starter" },
      }),
    });

    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      eventId: string;
      trackingId: string;
    };
    expect(body.eventId).toBe("1");
    expect(body.trackingId).toBe(`${tenantId}:tenant-created-1`);

    const events = await outboxRepository.listUnconsumed(tenantId, 10);
    expect(events).toHaveLength(1);
  });

  it("deduplicates repeated outbox commands by idempotency key", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const app = createApp({ outboxRepository });
    const body = {
      tenantId,
      eventType: "tenant.created.v1",
      idempotencyKey: "tenant-created-1",
      payload: { plan: "starter" },
    };

    const first = await app.request("http://localhost/v1/commands/outbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const second = await app.request("http://localhost/v1/commands/outbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await first.json()).toMatchObject(await second.json());

    const events = await outboxRepository.listUnconsumed(tenantId, 10);
    expect(events).toHaveLength(1);
  });

  it("accepts hello workflow triggers through outbox", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const restateWorkflowClient: RestateWorkflowClientPort = {
      startHelloWorkflow: vi.fn(async () => undefined),
      startTenantProvisioningWorkflow: vi.fn(async () => undefined),
    };
    const app = createApp({ outboxRepository, restateWorkflowClient });

    const response = await app.request("http://localhost/v1/workflows/hello", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tenantId,
        workflowId: "wf-hello-1",
        dedupeKey: "wf-hello-1",
        initiatedBy: "founder",
        message: "bootstrap workflow",
      }),
    });

    expect(response.status).toBe(202);
    const payload = (await response.json()) as { eventType: string };
    expect(payload.eventType).toBe("workflow.hello.requested.v1");
    expect(restateWorkflowClient.startHelloWorkflow).toHaveBeenCalledTimes(1);

    const events = await outboxRepository.listUnconsumed(tenantId, 10);
    expect(events).toHaveLength(1);
  });

  it("returns 503 for workflow trigger when outbox is unavailable", async () => {
    const app = createApp();
    const response = await app.request("http://localhost/v1/workflows/hello", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tenantId,
        workflowId: "wf-hello-1",
        dedupeKey: "wf-hello-1",
        initiatedBy: "founder",
        message: "bootstrap workflow",
      }),
    });

    expect(response.status).toBe(503);
  });

  it("accepts tenant provisioning workflow triggers through outbox", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const restateWorkflowClient: RestateWorkflowClientPort = {
      startHelloWorkflow: vi.fn(async () => undefined),
      startTenantProvisioningWorkflow: vi.fn(async () => undefined),
    };
    const app = createApp({ outboxRepository, restateWorkflowClient });

    const response = await app.request(
      "http://localhost/v1/workflows/tenant-provisioning",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenantId,
          workflowId: "wf-provision-1",
          dedupeKey: "wf-provision-1",
          tenantExternalId: "ten_lat_01",
          tenantName: "Lattice",
          requestedBy: "founder",
        }),
      },
    );

    expect(response.status).toBe(202);
    const payload = (await response.json()) as { eventType: string };
    expect(payload.eventType).toBe("workflow.tenant_provisioning.requested.v1");
    expect(
      restateWorkflowClient.startTenantProvisioningWorkflow,
    ).toHaveBeenCalledTimes(1);
  });

  it("returns 503 for tenant provisioning trigger when outbox is unavailable", async () => {
    const app = createApp();
    const response = await app.request(
      "http://localhost/v1/workflows/tenant-provisioning",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenantId,
          workflowId: "wf-provision-1",
          dedupeKey: "wf-provision-1",
          tenantExternalId: "ten_lat_01",
          tenantName: "Lattice",
          requestedBy: "founder",
        }),
      },
    );

    expect(response.status).toBe(503);
  });

  it("accepts tenant provisioning runtime callbacks through outbox", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const runtimeCallbackSecret = "test-secret";
    const app = createApp({ outboxRepository, runtimeCallbackSecret });
    const callbackPayload = {
      tenantId,
      workflowId: "wf-provision-1",
      dedupeKey: "wf-provision-1",
      tenantExternalId: "ten_lat_01",
      tenantName: "Lattice",
      requestedBy: "founder",
      callbackId: "cb-1",
      runtimeRunId: "run-1",
      progressStep: "paperclip.company.created",
      progressMessage: "Paperclip company created",
      progressPercent: 25,
    };
    const body = JSON.stringify(callbackPayload);
    const signature = createHmac("sha256", runtimeCallbackSecret)
      .update(body)
      .digest("hex");

    const response = await app.request(
      "http://localhost/v1/workflows/runtime-callbacks/tenant-provisioning",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-restate-signature": signature,
        },
        body,
      },
    );

    expect(response.status).toBe(202);
    const payload = (await response.json()) as { eventType: string };
    expect(payload.eventType).toBe("workflow.tenant_provisioning.completed.v1");

    const events = await outboxRepository.listUnconsumed(tenantId, 10);
    expect(events).toHaveLength(2);
    expect(events[0]?.eventType).toBe(
      "workflow.tenant_provisioning.progress.v1",
    );
    expect(events[1]?.eventType).toBe(
      "workflow.tenant_provisioning.completed.v1",
    );
  });

  it("returns 401 for tenant provisioning runtime callbacks with bad signature", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const app = createApp({
      outboxRepository,
      runtimeCallbackSecret: "test-secret",
    });

    const response = await app.request(
      "http://localhost/v1/workflows/runtime-callbacks/tenant-provisioning",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-restate-signature": "invalid",
        },
        body: JSON.stringify({
          tenantId,
          workflowId: "wf-provision-1",
          dedupeKey: "wf-provision-1",
          tenantExternalId: "ten_lat_01",
          tenantName: "Lattice",
          requestedBy: "founder",
          callbackId: "cb-1",
        }),
      },
    );

    expect(response.status).toBe(401);
  });

  it("upserts workflow run state on tenant-provisioning trigger", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const workflowRunRepository = new InMemoryWorkflowRunRepository();
    const restateWorkflowClient: RestateWorkflowClientPort = {
      startHelloWorkflow: vi.fn(async () => undefined),
      startTenantProvisioningWorkflow: vi.fn(async () => undefined),
    };
    const app = createApp({
      outboxRepository,
      workflowRunRepository,
      restateWorkflowClient,
    });

    await app.request("http://localhost/v1/workflows/tenant-provisioning", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tenantId,
        workflowId: "wf-sm-1",
        dedupeKey: "wf-sm-1",
        tenantExternalId: "ten_sm_01",
        tenantName: "Lattice",
        requestedBy: "founder",
      }),
    });

    const run = await workflowRunRepository.getByWorkflowId(
      tenantId,
      "wf-sm-1",
    );
    expect(run?.state).toBe("requested");
    expect(run?.workflowId).toBe("wf-sm-1");
  });

  it("transitions workflow run state on completed callback", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const workflowRunRepository = new InMemoryWorkflowRunRepository();
    const app = createApp({ outboxRepository, workflowRunRepository });

    // Seed the run as requested
    await workflowRunRepository.upsertRequested(tenantId, "wf-sm-2", "wf-sm-2");

    const response = await app.request(
      "http://localhost/v1/workflows/runtime-callbacks/tenant-provisioning",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenantId,
          workflowId: "wf-sm-2",
          dedupeKey: "wf-sm-2",
          tenantExternalId: "ten_sm_02",
          tenantName: "Lattice",
          requestedBy: "founder",
          callbackId: "cb-sm-2",
          callbackType: "completed",
        }),
      },
    );

    expect(response.status).toBe(202);
    const run = await workflowRunRepository.getByWorkflowId(
      tenantId,
      "wf-sm-2",
    );
    expect(run?.state).toBe("completed");
  });

  it("returns 409 when callback arrives on a terminal workflow run", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const workflowRunRepository = new InMemoryWorkflowRunRepository();
    const app = createApp({ outboxRepository, workflowRunRepository });

    // Seed and transition to completed
    await workflowRunRepository.upsertRequested(tenantId, "wf-sm-3", "wf-sm-3");
    await workflowRunRepository.transitionState(
      tenantId,
      "wf-sm-3",
      "requested",
      "completed",
    );

    // Attempt another completed callback — illegal transition
    const response = await app.request(
      "http://localhost/v1/workflows/runtime-callbacks/tenant-provisioning",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenantId,
          workflowId: "wf-sm-3",
          dedupeKey: "wf-sm-3",
          tenantExternalId: "ten_sm_03",
          tenantName: "Lattice",
          requestedBy: "founder",
          callbackId: "cb-sm-3b",
          callbackType: "completed",
        }),
      },
    );

    expect(response.status).toBe(409);
  });

  it("transitions workflow run to failed state on failed callback", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const workflowRunRepository = new InMemoryWorkflowRunRepository();
    const app = createApp({ outboxRepository, workflowRunRepository });

    await workflowRunRepository.upsertRequested(tenantId, "wf-sm-4", "wf-sm-4");

    const response = await app.request(
      "http://localhost/v1/workflows/runtime-callbacks/tenant-provisioning",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenantId,
          workflowId: "wf-sm-4",
          dedupeKey: "wf-sm-4",
          tenantExternalId: "ten_sm_04",
          tenantName: "Lattice",
          requestedBy: "founder",
          callbackId: "cb-sm-4",
          callbackType: "failed",
          failureCode: "TIMEOUT",
          failureMessage: "Timed out after 60s",
        }),
      },
    );

    expect(response.status).toBe(202);
    const run = await workflowRunRepository.getByWorkflowId(
      tenantId,
      "wf-sm-4",
    );
    expect(run?.state).toBe("failed");
    expect(run?.failureCode).toBe("TIMEOUT");
  });

  it("routes progress-only callbacks — emits one progress event, no terminal event", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const app = createApp({ outboxRepository });
    const callbackPayload = {
      tenantId,
      workflowId: "wf-provision-2",
      dedupeKey: "wf-provision-2",
      tenantExternalId: "ten_lat_02",
      tenantName: "Lattice",
      requestedBy: "founder",
      callbackId: "cb-progress-1",
      callbackType: "progress",
      progressStep: "gitea.repo.created",
      progressMessage: "Gitea workspace repo created",
      progressPercent: 50,
    };

    const response = await app.request(
      "http://localhost/v1/workflows/runtime-callbacks/tenant-provisioning/progress",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(callbackPayload),
      },
    );

    expect(response.status).toBe(202);
    const payload = (await response.json()) as {
      eventType: string;
      callbackType: string;
      targetState: string;
    };
    expect(payload.eventType).toBe("workflow.tenant_provisioning.progress.v1");
    expect(payload.callbackType).toBe("progress");
    expect(payload.targetState).toBe("in_progress");

    const events = await outboxRepository.listUnconsumed(tenantId, 10);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe(
      "workflow.tenant_provisioning.progress.v1",
    );
  });

  it("routes failed callbacks — emits progress + failed events", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const app = createApp({ outboxRepository });
    const callbackPayload = {
      tenantId,
      workflowId: "wf-provision-3",
      dedupeKey: "wf-provision-3",
      tenantExternalId: "ten_lat_03",
      tenantName: "Lattice",
      requestedBy: "founder",
      callbackId: "cb-fail-1",
      callbackType: "failed",
      failureCode: "PROVISIONING_TIMEOUT",
      failureMessage: "Provisioning timed out after 60s",
    };

    const response = await app.request(
      "http://localhost/v1/workflows/runtime-callbacks/tenant-provisioning",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(callbackPayload),
      },
    );

    expect(response.status).toBe(202);
    const payload = (await response.json()) as {
      eventType: string;
      callbackType: string;
      targetState: string;
    };
    expect(payload.eventType).toBe("workflow.tenant_provisioning.failed.v1");
    expect(payload.callbackType).toBe("failed");
    expect(payload.targetState).toBe("failed");

    const events = await outboxRepository.listUnconsumed(tenantId, 10);
    expect(events).toHaveLength(2);
    expect(events[0]?.eventType).toBe(
      "workflow.tenant_provisioning.progress.v1",
    );
    expect(events[1]?.eventType).toBe("workflow.tenant_provisioning.failed.v1");
  });

  it("returns 503 for tenant provisioning runtime callbacks without outbox", async () => {
    const app = createApp();
    const response = await app.request(
      "http://localhost/v1/workflows/runtime-callbacks/tenant-provisioning",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenantId,
          workflowId: "wf-provision-1",
          dedupeKey: "wf-provision-1",
          tenantExternalId: "ten_lat_01",
          tenantName: "Lattice",
          requestedBy: "founder",
          callbackId: "cb-1",
        }),
      },
    );

    expect(response.status).toBe(503);
  });

  it("returns 503 when outbox repository is missing", async () => {
    const app = createApp();
    const response = await app.request("http://localhost/v1/commands/outbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tenantId,
        eventType: "tenant.created.v1",
        idempotencyKey: "tenant-created-1",
        payload: { plan: "starter" },
      }),
    });

    expect(response.status).toBe(503);
  });

  it("bootstraps tenant through Paperclip client", async () => {
    const mockClient: PaperclipClientPort = {
      createCompany: vi.fn(async () => ({ id: "cmp_1", identifier: "LAT" })),
      createAgent: vi.fn(async () => ({
        id: "agt_1",
        identifier: "LAT-INB",
        name: "Inbound Strategist",
      })),
      createIssue: vi.fn(async () => ({
        id: "iss_1",
        identifier: "LAT-1",
        title: "Seed issue",
        status: "todo",
      })),
      checkoutIssue: vi.fn(),
      releaseIssue: vi.fn(),
      wakeupAgent: vi.fn(),
    };

    const app = createApp({ paperclipClient: mockClient });
    const response = await app.request(
      "http://localhost/v1/paperclip/bootstrap-tenant",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenantExternalId: "ten_lat_01",
          tenantName: "Lattice",
          initialAgent: {
            name: "Inbound Strategist",
            role: "content_strategist",
            title: "Inbound Content Strategist",
            budgetMonthlyCents: 4500,
          },
          seedIssue: {
            title: "Seed issue",
          },
        }),
      },
    );

    expect(response.status).toBe(202);
    expect(mockClient.createCompany).toHaveBeenCalledTimes(1);
    expect(mockClient.createAgent).toHaveBeenCalledTimes(1);
    expect(mockClient.createIssue).toHaveBeenCalledTimes(1);
    const responsePayload = (await response.json()) as {
      idempotencyKey: string;
    };
    expect(responsePayload.idempotencyKey).toContain("bootstrap:ten_lat_01");
  });

  it("uses provided idempotency key header on bootstrap", async () => {
    const mockClient: PaperclipClientPort = {
      createCompany: vi.fn(async () => ({ id: "cmp_1", identifier: "LAT" })),
      createAgent: vi.fn(async () => ({
        id: "agt_1",
        identifier: "LAT-INB",
        name: "Inbound Strategist",
      })),
      createIssue: vi.fn(async () => ({
        id: "iss_1",
        identifier: "LAT-1",
        title: "Seed issue",
        status: "todo",
      })),
      checkoutIssue: vi.fn(),
      releaseIssue: vi.fn(),
      wakeupAgent: vi.fn(),
    };

    const app = createApp({ paperclipClient: mockClient });
    const response = await app.request(
      "http://localhost/v1/paperclip/bootstrap-tenant",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "idem-123",
        },
        body: JSON.stringify({
          tenantExternalId: "ten_lat_01",
          tenantName: "Lattice",
          initialAgent: {
            name: "Inbound Strategist",
            role: "content_strategist",
            title: "Inbound Content Strategist",
            budgetMonthlyCents: 4500,
          },
          seedIssue: {
            title: "Seed issue",
          },
        }),
      },
    );

    expect(response.status).toBe(202);
    const payload = (await response.json()) as { idempotencyKey: string };
    expect(payload.idempotencyKey).toBe("idem-123");
    expect(mockClient.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          idempotency_key: "idem-123",
        }),
      }),
    );
  });

  it("returns 503 if Paperclip env config is missing", async () => {
    const app = createApp();
    const response = await app.request(
      "http://localhost/v1/paperclip/bootstrap-tenant",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenantExternalId: "ten_lat_01",
          tenantName: "Lattice",
          initialAgent: {
            name: "Inbound Strategist",
            role: "content_strategist",
            title: "Inbound Content Strategist",
            budgetMonthlyCents: 4500,
          },
          seedIssue: {
            title: "Seed issue",
          },
        }),
      },
    );

    expect(response.status).toBe(503);
  });

  it("maps zod validation errors to 422 for incomplete input", async () => {
    const motionStackRepository = new InMemoryMotionStackRepository();
    const app = createApp({ motionStackRepository });
    const response = await app.request("http://localhost/v1/motions/score", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "missing-fields" }),
    });

    expect(response.status).toBe(422);
  });

  it("supports integration path with fetch-backed PaperclipClient", async () => {
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
            title: "Seed issue",
            status: "todo",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );

    const app = createApp({
      paperclipClient: new PaperclipClient(
        {
          baseUrl: "http://localhost:3100",
          serviceToken: "svc_token",
          timeoutMs: 1000,
        },
        fetchMock,
      ),
    });

    const response = await app.request(
      "http://localhost/v1/paperclip/bootstrap-tenant",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenantExternalId: "ten_lat_01",
          tenantName: "Lattice",
          initialAgent: {
            name: "Inbound Strategist",
            role: "content_strategist",
            title: "Inbound Content Strategist",
            budgetMonthlyCents: 4500,
          },
          seedIssue: {
            title: "Seed issue",
          },
        }),
      },
    );

    expect(response.status).toBe(202);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/signals
// ---------------------------------------------------------------------------

describe("POST /v1/signals", () => {
  const makeSignalBody = (overrides: Record<string, unknown> = {}) => ({
    signalType: "competitive",
    source: "twitter",
    payload: { text: "Competitor launched feature X" },
    ...overrides,
  });

  it("ingests a valid signal and returns 202 with inserted=true", async () => {
    const signalEventsRepository = new InMemorySignalEventsRepository();
    const app = createApp({ signalEventsRepository });

    const res = await app.request("http://localhost/v1/signals", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Tenant-Id": tenantId,
      },
      body: JSON.stringify(makeSignalBody()),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as { inserted: boolean; signalId: string };
    expect(body.inserted).toBe(true);
    expect(body.signalId).toBeDefined();
  });

  it("returns inserted=false for duplicate externalId", async () => {
    const signalEventsRepository = new InMemorySignalEventsRepository();
    const app = createApp({ signalEventsRepository });

    const payload = makeSignalBody({ externalId: "sig-ext-001" });
    await app.request("http://localhost/v1/signals", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Tenant-Id": tenantId },
      body: JSON.stringify(payload),
    });
    const res2 = await app.request("http://localhost/v1/signals", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Tenant-Id": tenantId },
      body: JSON.stringify(payload),
    });

    const body = (await res2.json()) as { inserted: boolean };
    expect(body.inserted).toBe(false);
  });

  it("returns 400 when X-Tenant-Id header is missing", async () => {
    const signalEventsRepository = new InMemorySignalEventsRepository();
    const app = createApp({ signalEventsRepository });

    const res = await app.request("http://localhost/v1/signals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makeSignalBody()),
    });

    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid signalType", async () => {
    const signalEventsRepository = new InMemorySignalEventsRepository();
    const app = createApp({ signalEventsRepository });

    const res = await app.request("http://localhost/v1/signals", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Tenant-Id": tenantId,
      },
      body: JSON.stringify(makeSignalBody({ signalType: "unknown_type" })),
    });

    expect(res.status).toBe(400);
  });

  it("returns 503 when signalEventsRepository is not configured", async () => {
    const app = createApp(); // no DATABASE_URL set → no repository

    const res = await app.request("http://localhost/v1/signals", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Tenant-Id": tenantId,
      },
      body: JSON.stringify(makeSignalBody()),
    });

    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/approvals + POST /v1/approvals/decide
// ---------------------------------------------------------------------------

describe("GET /v1/approvals", () => {
  it("returns pending outbox events matching outputType filter", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    await outboxRepository.enqueue({
      tenantId,
      eventType: "blog_draft.v1",
      idempotencyKey: "draft-1",
      payload: { draft_id: "d-001", title: "PLG Explained" },
    });
    await outboxRepository.enqueue({
      tenantId,
      eventType: "content_brief.v1",
      idempotencyKey: "brief-1",
      payload: { brief_id: "b-001" },
    });

    const app = createApp({ outboxRepository });
    const res = await app.request(
      "http://localhost/v1/approvals?outputType=blog_draft.v1",
      { headers: { "X-Tenant-Id": tenantId } },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { outputType: string }[];
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.items[0]?.outputType).toBe("blog_draft.v1");
  });

  it("returns 400 when X-Tenant-Id is missing", async () => {
    const app = createApp({ outboxRepository: new InMemoryOutboxRepository() });
    const res = await app.request("http://localhost/v1/approvals");
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/approvals/decide", () => {
  it("records an approval decision and returns 202", async () => {
    const approvalFeedbackRepository = new InMemoryApprovalFeedbackRepository();
    const app = createApp({ approvalFeedbackRepository });

    const res = await app.request("http://localhost/v1/approvals/decide", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Tenant-Id": tenantId,
      },
      body: JSON.stringify({
        issueId: "00000000-0000-4000-8000-000000000101",
        outputType: "blog_draft.v1",
        action: "approved",
        learnOptIn: true,
      }),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      accepted: boolean;
      feedbackId: string;
      action: string;
    };
    expect(body.accepted).toBe(true);
    expect(body.action).toBe("approved");
    expect(body.feedbackId).toBeDefined();
  });

  it("accepts reject decision with reviewerNote", async () => {
    const approvalFeedbackRepository = new InMemoryApprovalFeedbackRepository();
    const app = createApp({ approvalFeedbackRepository });

    const res = await app.request("http://localhost/v1/approvals/decide", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Tenant-Id": tenantId,
      },
      body: JSON.stringify({
        issueId: "00000000-0000-4000-8000-000000000102",
        outputType: "blog_draft.v1",
        action: "rejected",
        reviewerNote: "Too promotional, rewrite from scratch",
        learnOptIn: true,
      }),
    });

    expect(res.status).toBe(202);
  });

  it("returns 400 for invalid action value", async () => {
    const approvalFeedbackRepository = new InMemoryApprovalFeedbackRepository();
    const app = createApp({ approvalFeedbackRepository });

    const res = await app.request("http://localhost/v1/approvals/decide", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Tenant-Id": tenantId,
      },
      body: JSON.stringify({
        issueId: "00000000-0000-4000-8000-000000000103",
        outputType: "blog_draft.v1",
        action: "auto_approved", // not allowed via API
      }),
    });

    expect(res.status).toBe(400);
  });

  it("returns 503 when approvalFeedbackRepository is not configured", async () => {
    const app = createApp();
    const res = await app.request("http://localhost/v1/approvals/decide", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Tenant-Id": tenantId,
      },
      body: JSON.stringify({
        issueId: "00000000-0000-4000-8000-000000000104",
        outputType: "blog_draft.v1",
        action: "approved",
      }),
    });

    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/motions/score
// ---------------------------------------------------------------------------

const scoringBody = {
  tenantId,
  productComplexity: 0.7,
  trialability: 0.6,
  acvBand: 0.5,
  salesCycleWeeks: 6,
  founderContentCapacity: 0.8,
  categorySearchDemand: 0.9,
  communityDensity: 0.7,
  telemetryReadiness: 0.6,
  budgetReadiness: 0.5,
};

describe("POST /v1/motions/score", () => {
  it("returns 201 with scoreId and scorerVersion", async () => {
    const motionStackRepository = new InMemoryMotionStackRepository();
    const app = createApp({ motionStackRepository });

    const res = await app.request("http://localhost/v1/motions/score", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(scoringBody),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      scoreId: string;
      scorerVersion: string;
      scores: Record<string, number>;
      primaryMotions: string[];
      secondaryMotions: string[];
      stackUpdated: boolean;
    };
    expect(body.scorerVersion).toBe("motion_scorer.v1");
    expect(typeof body.scoreId).toBe("string");
    expect(Array.isArray(body.primaryMotions)).toBe(true);
    expect(Array.isArray(body.secondaryMotions)).toBe(true);
    expect(body.primaryMotions).toHaveLength(2);
    expect(body.secondaryMotions).toHaveLength(2);
  });

  it("persists the score row to the repository", async () => {
    const motionStackRepository = new InMemoryMotionStackRepository();
    const app = createApp({ motionStackRepository });

    await app.request("http://localhost/v1/motions/score", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(scoringBody),
    });

    const overview = await motionStackRepository.getOverview(tenantId);
    expect(overview.latestScore).not.toBeNull();
    expect(overview.latestScore?.scorerVersion).toBe("motion_scorer.v1");
    expect(overview.recentScores).toHaveLength(1);
  });

  it("sets stackUpdated=true when no existing stack", async () => {
    const motionStackRepository = new InMemoryMotionStackRepository();
    const app = createApp({ motionStackRepository });

    const res = await app.request("http://localhost/v1/motions/score", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(scoringBody),
    });

    const body = (await res.json()) as { stackUpdated: boolean };
    expect(body.stackUpdated).toBe(true);
  });

  it("returns 422 for invalid body", async () => {
    const motionStackRepository = new InMemoryMotionStackRepository();
    const app = createApp({ motionStackRepository });

    const res = await app.request("http://localhost/v1/motions/score", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId }),
    });

    expect(res.status).toBe(422);
  });

  it("returns 400 for malformed JSON", async () => {
    const motionStackRepository = new InMemoryMotionStackRepository();
    const app = createApp({ motionStackRepository });

    const res = await app.request("http://localhost/v1/motions/score", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });

    expect(res.status).toBe(400);
  });

  it("returns 503 when motionStackRepository is not configured", async () => {
    const app = createApp();

    const res = await app.request("http://localhost/v1/motions/score", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(scoringBody),
    });

    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/motion
// ---------------------------------------------------------------------------

describe("GET /v1/motion", () => {
  it("returns null latestScore and latestStack when no data exists", async () => {
    const motionStackRepository = new InMemoryMotionStackRepository();
    const app = createApp({ motionStackRepository });

    const res = await app.request("http://localhost/v1/motion", {
      headers: { "X-Tenant-Id": tenantId },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      latestScore: null;
      latestStack: null;
      recentScores: unknown[];
    };
    expect(body.latestScore).toBeNull();
    expect(body.latestStack).toBeNull();
    expect(body.recentScores).toEqual([]);
  });

  it("returns the most recent score row when data exists", async () => {
    const motionStackRepository = new InMemoryMotionStackRepository();
    await motionStackRepository.recordScore({
      tenantId,
      scorerVersion: "motion_scorer.v1",
      scores: { plg: 0.85, inbound_content: 0.71 },
      inputsDigest: "abc123",
      rationale: ["High PLG signal"],
    });
    const app = createApp({ motionStackRepository });

    const res = await app.request("http://localhost/v1/motion", {
      headers: { "X-Tenant-Id": tenantId },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      latestScore: { scorerVersion: string; scores: Record<string, number> };
    };
    expect(body.latestScore?.scorerVersion).toBe("motion_scorer.v1");
    expect(body.latestScore?.scores?.plg).toBe(0.85);
  });

  it("returns 400 when X-Tenant-Id is missing", async () => {
    const motionStackRepository = new InMemoryMotionStackRepository();
    const app = createApp({ motionStackRepository });
    const res = await app.request("http://localhost/v1/motion");
    expect(res.status).toBe(400);
  });

  it("returns 503 when motionStackRepository is not configured", async () => {
    const app = createApp();
    const res = await app.request("http://localhost/v1/motion", {
      headers: { "X-Tenant-Id": tenantId },
    });
    expect(res.status).toBe(503);
  });

  it("respects historyLimit query param", async () => {
    const motionStackRepository = new InMemoryMotionStackRepository();
    for (let i = 0; i < 5; i++) {
      await motionStackRepository.recordScore({
        tenantId,
        scorerVersion: "motion_scorer.v1",
        scores: { plg: i * 0.1 },
        inputsDigest: `d-${i}`,
        rationale: [],
      });
    }
    const app = createApp({ motionStackRepository });

    const res = await app.request("http://localhost/v1/motion?historyLimit=3", {
      headers: { "X-Tenant-Id": tenantId },
    });
    const body = (await res.json()) as { recentScores: unknown[] };
    expect(body.recentScores).toHaveLength(3);
  });
});
