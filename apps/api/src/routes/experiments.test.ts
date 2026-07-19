import { InMemoryExperimentRepository } from "@growthos/db";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";

const tenantA = "00000000-0000-4000-8000-000000000001";
const tenantB = "00000000-0000-4000-8000-000000000002";

const jsonHeaders = (
  tenantId: string,
  authorization?: string,
): Record<string, string> => ({
  "content-type": "application/json",
  "X-Tenant-Id": tenantId,
  ...(authorization ? { Authorization: authorization } : {}),
});

const experimentPayload = (overrides: Record<string, unknown> = {}) => ({
  experimentKey: "activation-copy-v1",
  motion: "product_led_growth",
  experimentType: "landing_page_copy",
  unitType: "account",
  hypothesis: "Outcome-led copy increases activated accounts.",
  variantA: { headline: "Automate go-to-market operations" },
  variantB: { headline: "Turn every signal into a next best action" },
  metricName: "activation_rate",
  minSampleSize: 100,
  createdBy: "founder@growthos.test",
  ...overrides,
});

const observationPayload = (overrides: Record<string, unknown> = {}) => ({
  idempotencyKey: "activation-contact-1-20260719",
  entityType: "contact",
  entityId: "contact-1",
  variant: "a",
  metricName: "activation_rate",
  metricValue: 1,
  attributionConfidence: 0.92,
  attributionModel: "product_event_v1",
  source: "product_analytics",
  observedOutcome: { activated: true },
  evidence: { eventId: "evt-1" },
  ...overrides,
});

const createExperiment = async (
  app: ReturnType<typeof createApp>,
  tenantId = tenantA,
  overrides: Record<string, unknown> = {},
) => {
  const response = await app.request("http://localhost/v1/experiments", {
    method: "POST",
    headers: jsonHeaders(tenantId),
    body: JSON.stringify(experimentPayload(overrides)),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    tenantId: string;
    experiment: { id: string; tenantId: string; status: string };
  };
};

describe("/v1/experiments and /v1/outcomes", () => {
  it("creates, lists, and reads experiments without crossing tenant boundaries", async () => {
    const app = createApp({
      experimentRepository: new InMemoryExperimentRepository(),
    });

    const createdA = await createExperiment(app);
    const createdB = await createExperiment(app, tenantB, {
      experimentKey: "activation-copy-v2",
    });

    expect(createdA.tenantId).toBe(tenantA);
    expect(createdA.experiment.tenantId).toBe(tenantA);

    const listA = await app.request(
      "http://localhost/v1/experiments?limit=10",
      {
        headers: { "X-Tenant-Id": tenantA },
      },
    );
    expect(listA.status).toBe(200);
    expect(listA.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(listA.json()).resolves.toMatchObject({
      tenantId: tenantA,
      total: 1,
      items: [expect.objectContaining({ id: createdA.experiment.id })],
    });

    const getA = await app.request(
      `http://localhost/v1/experiments/${createdA.experiment.id}`,
      { headers: { "X-Tenant-Id": tenantA } },
    );
    expect(getA.status).toBe(200);
    const getABody = (await getA.json()) as {
      experiment: { createdAt: string; startedAt: string | null };
    };
    expect(getABody.experiment.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(getABody.experiment.startedAt).toBeNull();

    const crossTenant = await app.request(
      `http://localhost/v1/experiments/${createdA.experiment.id}`,
      { headers: { "X-Tenant-Id": tenantB } },
    );
    expect(crossTenant.status).toBe(404);

    const malformedId = await app.request(
      "http://localhost/v1/experiments/not-an-experiment-id",
      { headers: { "X-Tenant-Id": tenantA } },
    );
    expect(malformedId.status).toBe(400);

    // Keep the second returned id used, which guards against an accidental
    // fixture that creates both records under the first tenant.
    expect(createdB.experiment.tenantId).toBe(tenantB);
  });

  it("rejects tenant spoofing and malformed tenant or request data", async () => {
    const repository = new InMemoryExperimentRepository();
    const app = createApp({ experimentRepository: repository });

    const spoofedTenant = await app.request("http://localhost/v1/experiments", {
      method: "POST",
      headers: jsonHeaders(tenantA),
      body: JSON.stringify(experimentPayload({ tenantId: tenantB })),
    });
    expect(spoofedTenant.status).toBe(400);

    const malformedTenant = await app.request(
      "http://localhost/v1/experiments",
      {
        method: "POST",
        headers: jsonHeaders("not-a-tenant"),
        body: JSON.stringify(experimentPayload()),
      },
    );
    expect(malformedTenant.status).toBe(400);

    const malformedBody = await app.request("http://localhost/v1/experiments", {
      method: "POST",
      headers: jsonHeaders(tenantA),
      body: "{not valid json",
    });
    expect(malformedBody.status).toBe(400);

    const list = await repository.listRecent(tenantA);
    expect(list).toHaveLength(0);
  });

  it("enforces transition state, path-bound assignment IDs, and assignment idempotency", async () => {
    const app = createApp({
      experimentRepository: new InMemoryExperimentRepository(),
    });
    const created = await createExperiment(app);
    const experimentId = created.experiment.id;

    const staleTransition = await app.request(
      `http://localhost/v1/experiments/${experimentId}/transition`,
      {
        method: "POST",
        headers: jsonHeaders(tenantA),
        body: JSON.stringify({
          fromStatus: "running",
          toStatus: "concluded",
        }),
      },
    );
    expect(staleTransition.status).toBe(409);

    const illegalTransition = await app.request(
      `http://localhost/v1/experiments/${experimentId}/transition`,
      {
        method: "POST",
        headers: jsonHeaders(tenantA),
        body: JSON.stringify({
          fromStatus: "draft",
          toStatus: "concluded",
        }),
      },
    );
    expect(illegalTransition.status).toBe(409);

    const pathSpoof = await app.request(
      `http://localhost/v1/experiments/${experimentId}/assignments`,
      {
        method: "POST",
        headers: jsonHeaders(tenantA),
        body: JSON.stringify({
          experimentId: "00000000-0000-4000-8000-000000000999",
          entityType: "account",
          entityId: "account-1",
          variant: "a",
        }),
      },
    );
    expect(pathSpoof.status).toBe(400);

    const assignmentBody = {
      entityType: "account",
      entityId: "account-1",
      variant: "a",
      assignmentContext: { source: "website" },
      exposedAt: "2026-07-19T12:00:00.000Z",
    };
    const firstAssignment = await app.request(
      `http://localhost/v1/experiments/${experimentId}/assignments`,
      {
        method: "POST",
        headers: jsonHeaders(tenantA),
        body: JSON.stringify(assignmentBody),
      },
    );
    expect(firstAssignment.status).toBe(201);
    const firstAssignmentBody = (await firstAssignment.json()) as {
      idempotent: boolean;
      assignment: { id: string; exposedAt: string };
    };
    expect(firstAssignmentBody.idempotent).toBe(false);
    expect(firstAssignmentBody.assignment.exposedAt).toBe(
      "2026-07-19T12:00:00.000Z",
    );

    const duplicateAssignment = await app.request(
      `http://localhost/v1/experiments/${experimentId}/assignments`,
      {
        method: "POST",
        headers: jsonHeaders(tenantA),
        body: JSON.stringify(assignmentBody),
      },
    );
    expect(duplicateAssignment.status).toBe(200);
    await expect(duplicateAssignment.json()).resolves.toMatchObject({
      idempotent: true,
      assignment: { id: firstAssignmentBody.assignment.id },
    });

    const running = await app.request(
      `http://localhost/v1/experiments/${experimentId}/transition`,
      {
        method: "POST",
        headers: jsonHeaders(tenantA),
        body: JSON.stringify({ fromStatus: "draft", toStatus: "running" }),
      },
    );
    expect(running.status).toBe(200);

    const paused = await app.request(
      `http://localhost/v1/experiments/${experimentId}/transition`,
      {
        method: "POST",
        headers: jsonHeaders(tenantA),
        body: JSON.stringify({ fromStatus: "running", toStatus: "paused" }),
      },
    );
    expect(paused.status).toBe(200);

    const blockedAssignment = await app.request(
      `http://localhost/v1/experiments/${experimentId}/assignments`,
      {
        method: "POST",
        headers: jsonHeaders(tenantA),
        body: JSON.stringify({
          entityType: "account",
          entityId: "account-2",
          variant: "b",
        }),
      },
    );
    expect(blockedAssignment.status).toBe(409);
  });

  it("captures tenant-scoped observations and outcomes with immutable idempotency", async () => {
    const app = createApp({
      experimentRepository: new InMemoryExperimentRepository(),
    });
    const created = await createExperiment(app);
    const experimentId = created.experiment.id;

    const blockedObservation = await app.request(
      `http://localhost/v1/experiments/${experimentId}/observations`,
      {
        method: "POST",
        headers: jsonHeaders(tenantA),
        body: JSON.stringify(observationPayload()),
      },
    );
    expect(blockedObservation.status).toBe(409);

    const start = await app.request(
      `http://localhost/v1/experiments/${experimentId}/transition`,
      {
        method: "POST",
        headers: jsonHeaders(tenantA),
        body: JSON.stringify({ fromStatus: "draft", toStatus: "running" }),
      },
    );
    expect(start.status).toBe(200);

    const observation = await app.request(
      `http://localhost/v1/experiments/${experimentId}/observations`,
      {
        method: "POST",
        headers: jsonHeaders(tenantA),
        body: JSON.stringify(
          observationPayload({ observedAt: "2026-07-19T12:05:00.000Z" }),
        ),
      },
    );
    expect(observation.status).toBe(201);
    const observationBody = (await observation.json()) as {
      observation: { id: string; observedAt: string };
    };
    expect(observationBody.observation.observedAt).toBe(
      "2026-07-19T12:05:00.000Z",
    );

    const invalidAssignment = await app.request(
      `http://localhost/v1/experiments/${experimentId}/observations`,
      {
        method: "POST",
        headers: jsonHeaders(tenantA),
        body: JSON.stringify(
          observationPayload({
            idempotencyKey: "invalid-assignment",
            assignmentId: "00000000-0000-4000-8000-000000000123",
          }),
        ),
      },
    );
    expect(invalidAssignment.status).toBe(409);

    const observationList = await app.request(
      `http://localhost/v1/experiments/${experimentId}/observations?metricName=activation_rate`,
      { headers: { "X-Tenant-Id": tenantA } },
    );
    expect(observationList.status).toBe(200);
    await expect(observationList.json()).resolves.toMatchObject({
      tenantId: tenantA,
      experimentId,
      total: 1,
      items: [expect.objectContaining({ id: observationBody.observation.id })],
    });

    const crossTenantObservations = await app.request(
      `http://localhost/v1/experiments/${experimentId}/observations`,
      { headers: { "X-Tenant-Id": tenantB } },
    );
    expect(crossTenantObservations.status).toBe(404);

    const outcomeBody = {
      ...observationPayload({
        idempotencyKey: "outcome-contact-2-20260719",
        entityId: "contact-2",
        variant: "b",
        metricValue: 0,
      }),
      experimentId,
    };
    const firstOutcome = await app.request("http://localhost/v1/outcomes", {
      method: "POST",
      headers: jsonHeaders(tenantA),
      body: JSON.stringify(outcomeBody),
    });
    expect(firstOutcome.status).toBe(201);
    const firstOutcomeBody = (await firstOutcome.json()) as {
      observation: { id: string };
    };

    const duplicateOutcome = await app.request("http://localhost/v1/outcomes", {
      method: "POST",
      headers: jsonHeaders(tenantA),
      body: JSON.stringify(outcomeBody),
    });
    expect(duplicateOutcome.status).toBe(201);
    await expect(duplicateOutcome.json()).resolves.toMatchObject({
      observation: { id: firstOutcomeBody.observation.id },
    });

    const spoofedOutcomeTenant = await app.request(
      "http://localhost/v1/outcomes",
      {
        method: "POST",
        headers: jsonHeaders(tenantA),
        body: JSON.stringify({ ...outcomeBody, tenantId: tenantB }),
      },
    );
    expect(spoofedOutcomeTenant.status).toBe(400);
  });

  it("requires service authentication for all experiment and outcome endpoints when configured", async () => {
    const apiServiceToken = "experiment-service-token";
    const app = createApp({
      apiServiceToken,
      experimentRepository: new InMemoryExperimentRepository(),
    });

    const unauthenticatedRead = await app.request(
      "http://localhost/v1/experiments",
      { headers: { "X-Tenant-Id": tenantA } },
    );
    expect(unauthenticatedRead.status).toBe(401);

    const unauthenticatedCreate = await app.request(
      "http://localhost/v1/experiments",
      {
        method: "POST",
        headers: jsonHeaders(tenantA),
        body: JSON.stringify(experimentPayload()),
      },
    );
    expect(unauthenticatedCreate.status).toBe(401);

    const authorizedCreate = await app.request(
      "http://localhost/v1/experiments",
      {
        method: "POST",
        headers: jsonHeaders(tenantA, `Bearer ${apiServiceToken}`),
        body: JSON.stringify(experimentPayload()),
      },
    );
    expect(authorizedCreate.status).toBe(201);

    const unauthenticatedOutcome = await app.request(
      "http://localhost/v1/outcomes",
      {
        method: "POST",
        headers: jsonHeaders(tenantA),
        body: JSON.stringify({
          ...observationPayload(),
          experimentId: "00000000-0000-4000-8000-000000000111",
        }),
      },
    );
    expect(unauthenticatedOutcome.status).toBe(401);
  });

  it("returns 503 when the durable experiment store is explicitly unavailable", async () => {
    const app = createApp({ experimentRepository: null });

    const response = await app.request("http://localhost/v1/experiments", {
      method: "POST",
      headers: jsonHeaders(tenantA),
      body: JSON.stringify(experimentPayload()),
    });
    expect(response.status).toBe(503);

    const list = await app.request("http://localhost/v1/experiments", {
      headers: { "X-Tenant-Id": tenantA },
    });
    expect(list.status).toBe(503);
  });
});
