import { PaperclipClient, type PaperclipClientPort } from "@growthos/adapter";
import { InMemoryOutboxRepository } from "@growthos/db";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";

const tenantId = "00000000-0000-4000-8000-000000000001";

describe("API app", () => {
  it("returns health status", async () => {
    const app = createApp();
    const response = await app.request("http://localhost/health");
    expect(response.status).toBe(200);
  });

  it("scores motions with 202 response", async () => {
    const app = createApp();

    const response = await app.request("http://localhost/v1/motions/score", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tenantId: "ten_1",
        productComplexity: 0.7,
        trialability: 0.6,
        acvBand: 0.5,
        salesCycleWeeks: 6,
        founderContentCapacity: 0.8,
        categorySearchDemand: 0.9,
        communityDensity: 0.7,
        telemetryReadiness: 0.6,
        budgetReadiness: 0.5,
      }),
    });

    expect(response.status).toBe(202);
    const payload = (await response.json()) as { scorerVersion: string };
    expect(payload.scorerVersion).toBe("motion_scorer.v1");
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

  it("maps zod validation errors to 400", async () => {
    const app = createApp();
    const response = await app.request("http://localhost/v1/motions/score", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "missing-fields" }),
    });

    expect(response.status).toBe(400);
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
