import {
  InMemoryComponentHealthRepository,
  InMemoryExternalActionsRepository,
  InMemoryIncidentRepository,
  InMemoryOutboxRepository,
} from "@growthos/db";
import { describe, expect, it, vi } from "vitest";
import { OutboxPublisher, runtimeConfigFromEnv } from "./outbox-publisher.js";

const tenantA = "11111111-1111-4111-8111-111111111111";
const tenantB = "22222222-2222-4222-8222-222222222222";

const enqueueN8nDispatch = async (
  repository: InMemoryExternalActionsRepository,
  actionId: string,
): Promise<void> => {
  await repository.enqueueRequested({
    tenantId: tenantA,
    actionId,
    actionType: "email.send",
    approvedBy: "founder",
    idempotencyKey: actionId,
    requestPayload: {
      channel: "email",
      to: ["buyer@example.com"],
      subject: "Hello",
      text: "Hello from GrowthOS.",
    },
  });
};

describe("OutboxPublisher", () => {
  it("publishes unconsumed events and marks them consumed", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const publish = vi.fn(async () => undefined);
    const publisher = new OutboxPublisher({
      outboxRepository,
      eventPublisher: { publish },
    });

    await outboxRepository.enqueue({
      tenantId: tenantA,
      eventType: "signal.routed.v1",
      idempotencyKey: "dedupe-1",
      payload: { signal_id: "sig-1" },
    });

    const publishedCount = await publisher.publishPendingForTenant(tenantA, 50);
    const remaining = await outboxRepository.listUnconsumed(tenantA, 50);

    expect(publishedCount).toBe(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      "t.11111111-1111-4111-8111-111111111111.signal.routed.v1",
      { signal_id: "sig-1" },
    );
    expect(remaining).toHaveLength(0);
  });

  it("forwards durable Paperclip work handoffs to the tenant-scoped subject", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const publish = vi.fn(async () => undefined);
    const publisher = new OutboxPublisher({
      outboxRepository,
      eventPublisher: { publish },
    });

    await outboxRepository.enqueue({
      tenantId: tenantA,
      eventType: "paperclip.work.ready.v1",
      idempotencyKey: "run-1:work-ready",
      payload: {
        tenant_id: tenantA,
        paperclip_company_id: "cmp_1",
        paperclip_run_id: "run-1",
        paperclip_agent_id: "agt_1",
        paperclip_issue_id: "iss_1",
      },
    });

    await publisher.publishPendingForTenant(tenantA, 50);

    expect(publish).toHaveBeenCalledWith(
      "t.11111111-1111-4111-8111-111111111111.paperclip.work.ready.v1",
      expect.objectContaining({
        paperclip_issue_id: "iss_1",
        paperclip_run_id: "run-1",
      }),
    );
    expect(await outboxRepository.listUnconsumed(tenantA, 50)).toHaveLength(0);
  });

  it("does not mark consumed when publish fails", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const publisher = new OutboxPublisher({
      outboxRepository,
      eventPublisher: {
        publish: vi.fn(async () => {
          throw new Error("jetstream unavailable");
        }),
      },
    });

    await outboxRepository.enqueue({
      tenantId: tenantA,
      eventType: "critique.completed.v1",
      idempotencyKey: "dedupe-2",
      payload: { critique_id: "crt-1" },
    });

    await expect(
      publisher.publishPendingForTenant(tenantA, 50),
    ).rejects.toThrow("jetstream unavailable");

    const remaining = await outboxRepository.listUnconsumed(tenantA, 50);
    expect(remaining).toHaveLength(1);
  });

  it("materializes incident.opened events into the control-plane store before publishing", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const incidentRepository = new InMemoryIncidentRepository();
    const publish = vi.fn(async () => undefined);
    const publisher = new OutboxPublisher({
      outboxRepository,
      eventPublisher: { publish },
      incidentRepository,
    });
    await outboxRepository.enqueue({
      tenantId: tenantA,
      eventType: "incident.opened.v1",
      idempotencyKey: "incident-1",
      payload: {
        incident_key: "n8n:act-1:failed",
        component_id: "n8n-dispatch",
        severity: "high",
        title: "External action failed",
        summary: "n8n rejected a founder-approved action.",
        action: "quarantine_and_escalate",
        diagnostic_metadata: { action_id: "act-1", error_code: "HTTP_400" },
      },
    });

    await publisher.publishPendingForTenant(tenantA, 10);

    const incidents = await incidentRepository.listRecent(tenantA);
    expect(incidents).toMatchObject([
      {
        incidentKey: "n8n:act-1:failed",
        componentId: "n8n-dispatch",
        severity: "high",
        diagnosticMetadata: { action_id: "act-1", error_code: "HTTP_400" },
      },
    ]);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(await outboxRepository.listUnconsumed(tenantA, 10)).toHaveLength(0);
  });

  it("turns worker dead letters into sanitized founder-visible incidents", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const incidentRepository = new InMemoryIncidentRepository();
    const componentHealthRepository = new InMemoryComponentHealthRepository();
    const publisher = new OutboxPublisher({
      outboxRepository,
      eventPublisher: { publish: vi.fn(async () => undefined) },
      incidentRepository,
      componentHealthRepository,
    });
    await outboxRepository.enqueue({
      tenantId: tenantA,
      eventType: "worker.dead_lettered.v1",
      idempotencyKey: "router:42",
      payload: {
        worker: "signal_router",
        source_subject:
          "t.11111111-1111-4111-8111-111111111111.signal.routed.v1",
        stream_sequence: 42,
        redelivery_count: 5,
        error: "Bearer super-secret-token rejected by downstream service",
        failed_payload: { email: "buyer@example.com", apiKey: "do-not-store" },
      },
    });

    await publisher.publishPendingForTenant(tenantA, 10);

    const [incident] = await incidentRepository.listRecent(tenantA);
    expect(incident).toMatchObject({
      incidentKey:
        "dead-letter:signal_router:t.11111111-1111-4111-8111-111111111111.signal.routed.v1:42",
      componentId: "signal_router",
      severity: "high",
      action: "quarantine_and_escalate",
    });
    expect(incident?.summary).toContain("Bearer [redacted]");
    expect(incident?.diagnosticMetadata).toMatchObject({
      stream_sequence: 42,
      redelivery_count: 5,
    });
    expect(incident?.diagnosticMetadata).not.toHaveProperty("failed_payload");
    expect(incident?.diagnosticMetadata).toHaveProperty(
      "failed_payload_sha256",
    );

    expect(
      await componentHealthRepository.getByComponent(tenantA, "signal_router"),
    ).toMatchObject({
      state: "quarantined",
      action: "quarantine_and_escalate",
      allowExternalActions: false,
      errorRate: 1,
      consecutiveFailures: 5,
    });
  });

  it("leaves dead letters unconsumed when quarantined health cannot persist", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const publisher = new OutboxPublisher({
      outboxRepository,
      eventPublisher: { publish: vi.fn(async () => undefined) },
      componentHealthRepository: {
        record: async () => {
          throw new Error("component health database unavailable");
        },
        getByComponent: async () => null,
        listLatest: async () => [],
      },
    });
    await outboxRepository.enqueue({
      tenantId: tenantA,
      eventType: "worker.dead_lettered.v1",
      idempotencyKey: "router:43",
      payload: {
        worker: "signal_router",
        source_subject:
          "t.11111111-1111-4111-8111-111111111111.signal.routed.v1",
        stream_sequence: 43,
        error: "router failed",
      },
    });

    await expect(
      publisher.publishPendingForTenant(tenantA, 10),
    ).rejects.toThrow("component health database unavailable");
    expect(await outboxRepository.listUnconsumed(tenantA, 10)).toHaveLength(1);
  });

  it("leaves an incident event unconsumed when durable incident persistence fails", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const publisher = new OutboxPublisher({
      outboxRepository,
      eventPublisher: { publish: vi.fn(async () => undefined) },
      incidentRepository: {
        create: async () => {
          throw new Error("incident database unavailable");
        },
        getById: async () => null,
        listRecent: async () => [],
        transition: async () => null,
      },
    });
    await outboxRepository.enqueue({
      tenantId: tenantA,
      eventType: "incident.opened.v1",
      idempotencyKey: "incident-persist-failure",
      payload: {
        incident_key: "persistence-failure",
        component_id: "outbox",
        severity: "high",
        title: "Persistence failed",
        summary: "Intentional test failure.",
      },
    });

    await expect(
      publisher.publishPendingForTenant(tenantA, 10),
    ).rejects.toThrow("incident database unavailable");
    expect(await outboxRepository.listUnconsumed(tenantA, 10)).toHaveLength(1);
  });

  it("publishes in tenant batches and returns cycle metrics", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const publish = vi.fn(async () => undefined);
    const publisher = new OutboxPublisher({
      outboxRepository,
      eventPublisher: { publish },
    });

    await outboxRepository.enqueue({
      tenantId: tenantA,
      eventType: "signal.routed.v1",
      idempotencyKey: "dedupe-a",
      payload: { signal_id: "a" },
    });
    await outboxRepository.enqueue({
      tenantId: tenantB,
      eventType: "critique.completed.v1",
      idempotencyKey: "dedupe-b",
      payload: { critique_id: "b" },
    });

    const result = await publisher.publishCycle([tenantA, tenantB], 10);

    expect(result.publishedCount).toBe(2);
    expect(result.publishedByTenant).toEqual({
      [tenantA]: 1,
      [tenantB]: 1,
    });
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("dispatches n8n requests through the n8n client instead of NATS", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const externalActionsRepository = new InMemoryExternalActionsRepository(
      outboxRepository,
    );
    const publish = vi.fn(async () => undefined);
    const dispatch = vi.fn(async () => ({
      ok: true as const,
      status: 202,
      body: { accepted: true },
    }));
    const publisher = new OutboxPublisher({
      outboxRepository,
      eventPublisher: { publish },
      n8nDispatchClient: { dispatch },
      externalActionsRepository,
      n8nDispatchWorkerId: "test-worker",
      n8nDispatchResultCallbackUrl:
        "https://api.example/v1/n8n/dispatch-results",
    });

    await enqueueN8nDispatch(externalActionsRepository, "act-1");

    const publishedCount = await publisher.publishPendingForTenant(tenantA, 50);
    const remaining = await outboxRepository.listUnconsumed(tenantA, 50);

    expect(publishedCount).toBe(1);
    expect(publish).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "act-1",
        idempotencyKey: "act-1",
        callback: {
          url: "https://api.example/v1/n8n/dispatch-results",
        },
      }),
    );
    expect(
      remaining.some(
        (event) => event.eventType === "n8n.dispatch.requested.v1",
      ),
    ).toBe(false);
    expect(
      await externalActionsRepository.getByActionId(tenantA, "act-1"),
    ).toMatchObject({
      state: "dispatched",
    });
  });

  it("keeps retryable n8n dispatch failures unconsumed without tight-loop retries", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const externalActionsRepository = new InMemoryExternalActionsRepository(
      outboxRepository,
    );
    const dispatch = vi.fn(async () => ({
      ok: false as const,
      status: 503,
      error: "n8n unavailable",
      retryable: true,
    }));
    const publisher = new OutboxPublisher({
      outboxRepository,
      eventPublisher: { publish: vi.fn(async () => undefined) },
      n8nDispatchClient: { dispatch },
      externalActionsRepository,
      n8nDispatchWorkerId: "test-worker",
      n8nRetryBackoffMs: 60_000,
    });

    await enqueueN8nDispatch(externalActionsRepository, "act-2");

    const firstCount = await publisher.publishPendingForTenant(tenantA, 50);
    const secondCount = await publisher.publishPendingForTenant(tenantA, 50);

    const remaining = await outboxRepository.listUnconsumed(tenantA, 50);
    expect(firstCount).toBe(0);
    // The second cycle may publish the retry lifecycle event, but it must not
    // make another external call before the persisted retry deadline.
    expect(secondCount).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(
      remaining.filter(
        (event) => event.eventType === "n8n.dispatch.requested.v1",
      ),
    ).toHaveLength(1);
    expect(
      await externalActionsRepository.getByActionId(tenantA, "act-2"),
    ).toMatchObject({
      state: "retry_scheduled",
    });
  });
});

describe("runtimeConfigFromEnv", () => {
  it("parses tenant and runtime values from env", () => {
    const config = runtimeConfigFromEnv({
      OUTBOX_TENANT_IDS: `${tenantA},${tenantB}`,
      OUTBOX_BATCH_SIZE_PER_TENANT: "25",
      OUTBOX_POLL_INTERVAL_MS: "1500",
    });

    expect(config).toEqual({
      tenantIds: [tenantA, tenantB],
      batchSizePerTenant: 25,
      pollIntervalMs: 1500,
    });
  });
});
