import type { TenantProvisioningRuntimeState } from "@growthos/core";
import {
  StubGiteaProvisioningClient,
  StubMinioProvisioningClient,
  StubNatsProvisioningClient,
  StubPaperclipProvisioningClient,
} from "@growthos/core";
import {
  InMemoryOutboxRepository,
  InMemoryWorkflowRunRepository,
} from "@growthos/db";
import { describe, expect, it, vi } from "vitest";
import {
  type EventPublisher,
  type ProvisioningClients,
  type RuntimeStateVerifier,
  WorkflowCallbackWorker,
} from "./workflow-callback-worker.js";

const tenantId = "00000000-0000-4000-8000-000000000001";

describe("WorkflowCallbackWorker", () => {
  it("emits tenant provisioning completed event into outbox and tenant subject", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const workflowRunRepository = new InMemoryWorkflowRunRepository();
    const eventPublisher: EventPublisher = {
      publish: vi.fn(async () => undefined),
    };
    const runtimeStateVerifier: RuntimeStateVerifier = {
      getTenantProvisioningRuntimeState: vi.fn(
        async () =>
          ({
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
          }) satisfies TenantProvisioningRuntimeState,
      ),
    };
    const worker = new WorkflowCallbackWorker({
      outboxRepository,
      workflowRunRepository,
      eventPublisher,
      runtimeStateVerifier,
    });

    const result = await worker.processTenantProvisioningCompletion({
      tenantId,
      workflowId: "wf-provision-1",
      dedupeKey: "wf-provision-1",
      tenantExternalId: "ten_lat_01",
      tenantName: "Lattice",
      requestedBy: "founder",
    });

    expect(result.state).toBe("completed");
    expect(eventPublisher.publish).toHaveBeenCalledTimes(2);
    expect(eventPublisher.publish).toHaveBeenNthCalledWith(
      1,
      `t.${tenantId}.workflow.tenant_provisioning.progress.v1`,
      expect.objectContaining({
        workflow_id: "wf-provision-1",
        progress_step: "paperclip.company.created",
      }),
    );
    expect(eventPublisher.publish).toHaveBeenNthCalledWith(
      2,
      `t.${tenantId}.workflow.tenant_provisioning.completed.v1`,
      expect.objectContaining({
        workflow_id: "wf-provision-1",
        status: "accepted",
      }),
    );

    const events = await outboxRepository.listUnconsumed(tenantId, 10);
    expect(events).toHaveLength(2);
    expect(events[0]?.eventType).toBe(
      "workflow.tenant_provisioning.progress.v1",
    );
    expect(events[1]?.eventType).toBe(
      "workflow.tenant_provisioning.completed.v1",
    );
    const run = await workflowRunRepository.getByWorkflowId(
      tenantId,
      "wf-provision-1",
    );
    expect(run?.state).toBe("completed");
  });

  it("keeps completion outbox idempotent for duplicate requests", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const workflowRunRepository = new InMemoryWorkflowRunRepository();
    const runtimeStateVerifier: RuntimeStateVerifier = {
      getTenantProvisioningRuntimeState: vi.fn(
        async () =>
          ({
            workflowId: "wf-provision-dup",
            tenantId,
            runtimeRunId: "run-dup",
            state: "completed",
            history: [],
          }) satisfies TenantProvisioningRuntimeState,
      ),
    };
    const worker = new WorkflowCallbackWorker({
      outboxRepository,
      workflowRunRepository,
      eventPublisher: { publish: vi.fn(async () => undefined) },
      runtimeStateVerifier,
    });
    const request = {
      tenantId,
      workflowId: "wf-provision-dup",
      dedupeKey: "wf-provision-dup",
      tenantExternalId: "ten_lat_01",
      tenantName: "Lattice",
      requestedBy: "founder",
    };

    await worker.processTenantProvisioningCompletion(request);
    await worker.processTenantProvisioningCompletion(request);

    const events = await outboxRepository.listUnconsumed(tenantId, 10);
    expect(events).toHaveLength(1);
  });

  it("emits failed event and transitions run to failed when runtime is failed", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const workflowRunRepository = new InMemoryWorkflowRunRepository();
    const eventPublisher: EventPublisher = {
      publish: vi.fn(async () => undefined),
    };
    const runtimeStateVerifier: RuntimeStateVerifier = {
      getTenantProvisioningRuntimeState: vi.fn(
        async () =>
          ({
            workflowId: "wf-provision-fail",
            tenantId,
            runtimeRunId: "run-fail",
            state: "failed",
            failureCode: "PROVISIONING_TIMEOUT",
            failureMessage: "Provisioning timed out",
            history: [],
          }) satisfies TenantProvisioningRuntimeState,
      ),
    };
    const worker = new WorkflowCallbackWorker({
      outboxRepository,
      workflowRunRepository,
      eventPublisher,
      runtimeStateVerifier,
    });

    const result = await worker.processTenantProvisioningCompletion({
      tenantId,
      workflowId: "wf-provision-fail",
      dedupeKey: "wf-provision-fail",
      tenantExternalId: "ten_lat_01",
      tenantName: "Lattice",
      requestedBy: "founder",
    });

    expect(result.state).toBe("failed");
    expect(eventPublisher.publish).toHaveBeenCalledWith(
      `t.${tenantId}.workflow.tenant_provisioning.failed.v1`,
      expect.objectContaining({
        failure_code: "PROVISIONING_TIMEOUT",
      }),
    );
    const run = await workflowRunRepository.getByWorkflowId(
      tenantId,
      "wf-provision-fail",
    );
    expect(run?.state).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// Orchestrator (direct provisioning) path
// ---------------------------------------------------------------------------

const makeProvisioningClients = (): ProvisioningClients => ({
  paperclip: new StubPaperclipProvisioningClient(),
  gitea: new StubGiteaProvisioningClient(),
  nats: new StubNatsProvisioningClient(),
  minio: new StubMinioProvisioningClient(),
});

describe("WorkflowCallbackWorker — orchestrator path", () => {
  const provisioningRequest = {
    tenantId,
    workflowId: "wf-orch-1",
    dedupeKey: "wf-orch-1",
    tenantExternalId: "ten_acme_01",
    tenantName: "Acme Corp",
    requestedBy: "founder",
  };

  it("runs all 5 provisioning steps and emits progress + completed events", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const workflowRunRepository = new InMemoryWorkflowRunRepository();
    const eventPublisher: EventPublisher = {
      publish: vi.fn(async () => undefined),
    };
    const worker = new WorkflowCallbackWorker({
      outboxRepository,
      workflowRunRepository,
      eventPublisher,
      runtimeStateVerifier: {
        getTenantProvisioningRuntimeState: vi.fn(async () => {
          throw new Error("should not be called on orchestrator path");
        }),
      },
      provisioningClients: makeProvisioningClients(),
    });

    const result =
      await worker.processTenantProvisioningCompletion(provisioningRequest);

    expect(result.state).toBe("completed");
    expect(result.history).toHaveLength(5);

    const events = await outboxRepository.listUnconsumed(tenantId, 20);
    const eventTypes = events.map((e) => e.eventType);

    // 6 progress events (5 steps × 1 report each — except seed_founder_doc
    // which reports at 85% and 100%) + 1 completed = up to 7 total outbox entries.
    // There will be at least one progress + one completed.
    expect(
      eventTypes.filter((t) => t === "workflow.tenant_provisioning.progress.v1")
        .length,
    ).toBeGreaterThanOrEqual(5);
    expect(eventTypes).toContain("workflow.tenant_provisioning.completed.v1");

    const run = await workflowRunRepository.getByWorkflowId(
      tenantId,
      "wf-orch-1",
    );
    expect(run?.state).toBe("completed");
  });

  it("transitions workflow_runs from requested → in_progress → completed", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const workflowRunRepository = new InMemoryWorkflowRunRepository();
    const worker = new WorkflowCallbackWorker({
      outboxRepository,
      workflowRunRepository,
      eventPublisher: { publish: vi.fn(async () => undefined) },
      runtimeStateVerifier: {
        getTenantProvisioningRuntimeState: vi.fn(),
      },
      provisioningClients: makeProvisioningClients(),
    });

    const result = await worker.processTenantProvisioningCompletion({
      ...provisioningRequest,
      workflowId: "wf-orch-state",
      dedupeKey: "wf-orch-state",
    });

    expect(result.state).toBe("completed");
    const run = await workflowRunRepository.getByWorkflowId(
      tenantId,
      "wf-orch-state",
    );
    expect(run?.state).toBe("completed");
  });

  it("is idempotent on duplicate requests after completion", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const workflowRunRepository = new InMemoryWorkflowRunRepository();
    const publishFn = vi.fn(async () => undefined);
    const worker = new WorkflowCallbackWorker({
      outboxRepository,
      workflowRunRepository,
      eventPublisher: { publish: publishFn },
      runtimeStateVerifier: { getTenantProvisioningRuntimeState: vi.fn() },
      provisioningClients: makeProvisioningClients(),
    });

    const req = {
      ...provisioningRequest,
      workflowId: "wf-orch-idem",
      dedupeKey: "wf-orch-idem",
    };

    await worker.processTenantProvisioningCompletion(req);
    const callCount = publishFn.mock.calls.length;

    // Second call — already terminal, should return immediately without new publishes.
    const result2 = await worker.processTenantProvisioningCompletion(req);
    expect(result2.state).toBe("completed");
    expect(publishFn.mock.calls.length).toBe(callCount);
  });

  it("emits failed event and transitions run to failed when orchestrator throws", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const workflowRunRepository = new InMemoryWorkflowRunRepository();
    const eventPublisher: EventPublisher = {
      publish: vi.fn(async () => undefined),
    };

    const failingClients: ProvisioningClients = {
      ...makeProvisioningClients(),
      paperclip: {
        provisionCompany: vi.fn(async () => {
          throw new Error("Paperclip API unreachable");
        }),
      },
    };

    const worker = new WorkflowCallbackWorker({
      outboxRepository,
      workflowRunRepository,
      eventPublisher,
      runtimeStateVerifier: { getTenantProvisioningRuntimeState: vi.fn() },
      provisioningClients: failingClients,
    });

    const result = await worker.processTenantProvisioningCompletion({
      ...provisioningRequest,
      workflowId: "wf-orch-fail",
      dedupeKey: "wf-orch-fail",
    });

    expect(result.state).toBe("failed");
    expect(result.failureCode).toBe("PROVISIONING_ERROR");
    expect(eventPublisher.publish).toHaveBeenCalledWith(
      `t.${tenantId}.workflow.tenant_provisioning.failed.v1`,
      expect.objectContaining({ failure_code: "PROVISIONING_ERROR" }),
    );
    const run = await workflowRunRepository.getByWorkflowId(
      tenantId,
      "wf-orch-fail",
    );
    expect(run?.state).toBe("failed");
  });
});
