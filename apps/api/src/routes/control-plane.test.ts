import {
  InMemoryApprovalFeedbackRepository,
  InMemoryExperimentRepository,
  InMemoryLearningProposalRepository,
  InMemoryMotionStackRepository,
  InMemoryOutboxRepository,
  InMemorySignalEventsRepository,
} from "@growthos/db";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import type {
  ComponentHealthControlPlaneRepository,
  IncidentControlPlaneRepository,
} from "./control-plane.js";

const tenantA = "00000000-0000-4000-8000-000000000001";
const tenantB = "00000000-0000-4000-8000-000000000002";

const healthRecords = {
  [tenantA]: [
    {
      componentId: "n8n-dispatch",
      state: "degraded" as const,
      action: "use_fallback",
      allowExternalActions: true,
      reasons: ["Primary webhook is unavailable."],
      observedAt: new Date("2026-07-19T12:00:00.000Z"),
      errorRate: 0.12,
    },
    {
      componentId: "email-connector",
      state: "quarantined" as const,
      action: "rollback",
      allowExternalActions: false,
      reasons: ["A consent guardrail was breached."],
      observedAt: new Date("2026-07-19T12:01:00.000Z"),
    },
  ],
  [tenantB]: [
    {
      componentId: "tenant-b-only",
      state: "healthy" as const,
      action: "none",
      allowExternalActions: true,
      reasons: ["Within policy."],
      observedAt: new Date("2026-07-19T12:02:00.000Z"),
    },
  ],
};

const incidentRecords = {
  [tenantA]: [
    {
      id: "00000000-0000-4000-8000-000000000101",
      componentId: "email-connector",
      severity: "critical" as const,
      status: "open",
      title: "Consent guardrail breach",
      summary: "Consent guardrail breach; external actions were stopped.",
      openedAt: new Date("2026-07-19T12:01:00.000Z"),
      resolvedAt: null,
      diagnosticMetadata: { customerEmail: "must-not-leak@example.com" },
    },
    {
      id: "00000000-0000-4000-8000-000000000102",
      componentId: "n8n-dispatch",
      severity: "medium" as const,
      status: "resolved",
      title: "Webhook fallback",
      summary: "Webhook fallback succeeded.",
      openedAt: new Date("2026-07-19T11:00:00.000Z"),
      resolvedAt: new Date("2026-07-19T11:05:00.000Z"),
    },
  ],
  [tenantB]: [
    {
      id: "00000000-0000-4000-8000-000000000103",
      componentId: "tenant-b-only",
      severity: "high" as const,
      status: "open",
      title: "Tenant B only",
      summary: "Must never appear in tenant A responses.",
      openedAt: new Date("2026-07-19T12:00:00.000Z"),
      resolvedAt: null,
    },
  ],
};

const componentHealthRepository: ComponentHealthControlPlaneRepository = {
  async listLatest(tenantId) {
    return healthRecords[tenantId as keyof typeof healthRecords] ?? [];
  },
};

const incidentRepository: IncidentControlPlaneRepository = {
  async listRecent(tenantId) {
    return incidentRecords[tenantId as keyof typeof incidentRecords] ?? [];
  },
};

const experimentRepository = new InMemoryExperimentRepository();
experimentRepository.getSummary = async (tenantId) =>
  tenantId === tenantA
    ? {
        total: 3,
        byStatus: {
          draft: 0,
          running: 1,
          paused: 0,
          concluded: 1,
          abandoned: 0,
          promoted: 0,
          rolled_back: 1,
        },
      }
    : {
        total: 0,
        byStatus: {
          draft: 0,
          running: 0,
          paused: 0,
          concluded: 0,
          abandoned: 0,
          promoted: 0,
          rolled_back: 0,
        },
      };

const learningProposalRepository = new InMemoryLearningProposalRepository();
learningProposalRepository.getSummary = async (tenantId) =>
  tenantId === tenantA
    ? {
        total: 2,
        byStatus: {
          awaiting_evidence: 0,
          evaluating: 0,
          requires_approval: 1,
          approved: 0,
          rejected: 0,
          promoted: 1,
          rolled_back: 0,
        },
      }
    : {
        total: 0,
        byStatus: {
          awaiting_evidence: 0,
          evaluating: 0,
          requires_approval: 0,
          approved: 0,
          rejected: 0,
          promoted: 0,
          rolled_back: 0,
        },
      };

describe("/v1/control-plane", () => {
  it("returns a tenant-isolated operational summary from configured stores", async () => {
    const signals = new InMemorySignalEventsRepository();
    const outbox = new InMemoryOutboxRepository();
    const approvals = new InMemoryApprovalFeedbackRepository();
    const motions = new InMemoryMotionStackRepository();

    await signals.ingest({
      tenantId: tenantA,
      signalType: "market",
      source: "crm",
      payload: { account: "A" },
    });
    await signals.ingest({
      tenantId: tenantB,
      signalType: "market",
      source: "crm",
      payload: { account: "B" },
    });
    await outbox.enqueue({
      tenantId: tenantA,
      eventType: "blog_draft.v1",
      idempotencyKey: "pending-a",
      payload: { issueId: "00000000-0000-4000-8000-000000000201" },
    });
    await outbox.enqueue({
      tenantId: tenantB,
      eventType: "blog_draft.v1",
      idempotencyKey: "pending-b",
      payload: { issueId: "00000000-0000-4000-8000-000000000202" },
    });
    await approvals.record({
      tenantId: tenantA,
      issueId: "00000000-0000-4000-8000-000000000203",
      outputType: "blog_draft.v1",
      action: "approved",
      learnOptIn: true,
    });
    await motions.recordScore({
      tenantId: tenantA,
      scorerVersion: "motion_scorer.v1",
      scores: { inbound_content: 0.9 },
      inputsDigest: "test-inputs",
      rationale: ["test"],
    });

    const app = createApp({
      signalEventsRepository: signals,
      outboxRepository: outbox,
      approvalFeedbackRepository: approvals,
      motionStackRepository: motions,
      componentHealthRepository,
      incidentRepository,
      experimentRepository,
      learningProposalRepository,
    });

    const response = await app.request(
      "http://localhost/v1/control-plane/summary",
      { headers: { "X-Tenant-Id": tenantA } },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = (await response.json()) as {
      tenantId: string;
      partial: boolean;
      dataSources: Record<string, string>;
      signals: { today: number };
      approvals: { pending: number };
      execution: { pendingOutboxEvents: number };
      motion: { scorerVersion: string | null };
      health: {
        overall: string;
        components: number;
        quarantined: number;
        externalActionsBlocked: number;
      };
      incidents: { open: number; criticalOpen: number };
      experiments: { total: number; running: number; rolledBack: number };
      learning: { total: number; requiresApproval: number; promoted: number };
    };

    expect(body.tenantId).toBe(tenantA);
    expect(body.partial).toBe(false);
    expect(body.dataSources).toEqual({
      signals: "available",
      outbox: "available",
      approvals: "available",
      motion: "available",
      componentHealth: "available",
      incidents: "available",
      experiments: "available",
      learningProposals: "available",
    });
    expect(body.signals.today).toBe(1);
    expect(body.approvals.pending).toBe(1);
    expect(body.execution.pendingOutboxEvents).toBe(1);
    expect(body.motion.scorerVersion).toBe("motion_scorer.v1");
    expect(body.health).toMatchObject({
      overall: "quarantined",
      components: 2,
      quarantined: 1,
      externalActionsBlocked: 1,
    });
    expect(body.incidents).toMatchObject({ open: 1, criticalOpen: 1 });
    expect(body.experiments).toMatchObject({
      total: 3,
      running: 1,
      rolledBack: 1,
    });
    expect(body.learning).toMatchObject({
      total: 2,
      requiresApproval: 1,
      promoted: 1,
    });
  });

  it("returns a partial but explicit summary when only a subset of stores is configured", async () => {
    const signals = new InMemorySignalEventsRepository();
    const app = createApp({ signalEventsRepository: signals });

    const response = await app.request(
      "http://localhost/v1/control-plane/summary",
      { headers: { "X-Tenant-Id": tenantA } },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      partial: boolean;
      dataSources: Record<string, string>;
      health: { overall: string };
    };
    expect(body.partial).toBe(true);
    expect(body.dataSources.signals).toBe("available");
    expect(body.dataSources.componentHealth).toBe("not_configured");
    expect(body.health.overall).toBe("unknown");
  });

  it("marks a failed read unavailable instead of presenting it as a zero", async () => {
    const signals = new InMemorySignalEventsRepository();
    signals.countSince = async () => {
      throw new Error("database unavailable");
    };
    const emptyIncidents: IncidentControlPlaneRepository = {
      async listRecent() {
        return [];
      },
    };
    const app = createApp({
      signalEventsRepository: signals,
      incidentRepository: emptyIncidents,
    });

    const response = await app.request(
      "http://localhost/v1/control-plane/summary",
      { headers: { "X-Tenant-Id": tenantA } },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      partial: boolean;
      dataSources: Record<string, string>;
      signals: { today: number };
    };
    expect(body.partial).toBe(true);
    expect(body.dataSources.signals).toBe("unavailable");
    expect(body.signals.today).toBe(0);
  });

  it("returns 503 rather than fabricated values when no control-plane store is configured", async () => {
    const app = createApp();

    const response = await app.request(
      "http://localhost/v1/control-plane/summary",
      { headers: { "X-Tenant-Id": tenantA } },
    );

    expect(response.status).toBe(503);
  });

  it("returns an empty configured incident list distinctly from an unavailable incident store", async () => {
    const emptyIncidents: IncidentControlPlaneRepository = {
      async listRecent() {
        return [];
      },
    };
    const app = createApp({ incidentRepository: emptyIncidents });

    const response = await app.request(
      "http://localhost/v1/control-plane/incidents",
      { headers: { "X-Tenant-Id": tenantA } },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      tenantId: tenantA,
      items: [],
      total: 0,
      open: 0,
    });

    const unavailable = createApp();
    const unavailableResponse = await unavailable.request(
      "http://localhost/v1/control-plane/incidents",
      { headers: { "X-Tenant-Id": tenantA } },
    );
    expect(unavailableResponse.status).toBe(503);
  });

  it("returns 503 when a configured health or incident store cannot be read", async () => {
    const unavailableHealth: ComponentHealthControlPlaneRepository = {
      async listLatest() {
        throw new Error("health store offline");
      },
    };
    const unavailableIncidents: IncidentControlPlaneRepository = {
      async listRecent() {
        throw new Error("incident store offline");
      },
    };
    const app = createApp({
      componentHealthRepository: unavailableHealth,
      incidentRepository: unavailableIncidents,
    });

    const [healthResponse, incidentResponse] = await Promise.all([
      app.request("http://localhost/v1/control-plane/health", {
        headers: { "X-Tenant-Id": tenantA },
      }),
      app.request("http://localhost/v1/control-plane/incidents", {
        headers: { "X-Tenant-Id": tenantA },
      }),
    ]);

    expect(healthResponse.status).toBe(503);
    expect(incidentResponse.status).toBe(503);
  });

  it("returns only sanitized, tenant-scoped component health and incident data", async () => {
    const app = createApp({ componentHealthRepository, incidentRepository });

    const [healthResponse, incidentResponse] = await Promise.all([
      app.request("http://localhost/v1/control-plane/health", {
        headers: { "X-Tenant-Id": tenantA },
      }),
      app.request("http://localhost/v1/control-plane/incidents", {
        headers: { "X-Tenant-Id": tenantA },
      }),
    ]);

    expect(healthResponse.status).toBe(200);
    const health = (await healthResponse.json()) as {
      items: Array<Record<string, unknown>>;
    };
    expect(health).toMatchObject({
      tenantId: tenantA,
      overall: "quarantined",
      total: 2,
    });
    expect(health.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          componentId: "n8n-dispatch",
          state: "degraded",
          action: "use_fallback",
          allowExternalActions: true,
        }),
      ]),
    );
    expect(health.items[0]).not.toHaveProperty("errorRate");

    expect(incidentResponse.status).toBe(200);
    const incidents = (await incidentResponse.json()) as {
      items: Array<Record<string, unknown>>;
    };
    expect(incidents).toMatchObject({
      tenantId: tenantA,
      total: 2,
      open: 1,
    });
    expect(incidents.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          componentId: "email-connector",
          severity: "critical",
          summary: "Consent guardrail breach; external actions were stopped.",
        }),
      ]),
    );
    expect(incidents.items[0]).not.toHaveProperty("diagnosticMetadata");
  });

  it("requires service authentication for control-plane reads when configured", async () => {
    const app = createApp({
      apiServiceToken: "control-plane-token",
      signalEventsRepository: new InMemorySignalEventsRepository(),
    });

    const unauthorized = await app.request(
      "http://localhost/v1/control-plane/summary",
      { headers: { "X-Tenant-Id": tenantA } },
    );
    expect(unauthorized.status).toBe(401);

    const authorized = await app.request(
      "http://localhost/v1/control-plane/summary",
      {
        headers: {
          "X-Tenant-Id": tenantA,
          Authorization: "Bearer control-plane-token",
        },
      },
    );
    expect(authorized.status).toBe(200);
  });

  it("rejects a malformed tenant identifier before a repository read", async () => {
    const app = createApp({ componentHealthRepository });

    const response = await app.request(
      "http://localhost/v1/control-plane/health",
      { headers: { "X-Tenant-Id": "not-a-tenant" } },
    );

    expect(response.status).toBe(400);
  });
});
