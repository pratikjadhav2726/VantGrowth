import { describe, expect, it } from "vitest";
import {
  ExternalActionConflictError,
  ExternalActionNotFoundError,
  InMemoryExternalActionsRepository,
  externalActionRequestDigest,
} from "./external-actions-repository.js";
import { InMemoryOutboxRepository } from "./outbox-repository.js";

const tenantId = "00000000-0000-4000-8000-000000000001";

const request = {
  tenantId,
  actionId: "email-welcome-1",
  actionType: "email.send",
  approvedBy: "founder",
  idempotencyKey: "email-welcome-1",
  requestPayload: {
    channel: "email",
    to: ["buyer@example.com"],
    subject: "Welcome",
    text: "Welcome to GrowthOS.",
  },
};

describe("InMemoryExternalActionsRepository", () => {
  it("creates the action and dispatch event idempotently", async () => {
    const outbox = new InMemoryOutboxRepository();
    const repository = new InMemoryExternalActionsRepository(outbox);

    const first = await repository.enqueueRequested(request);
    const second = await repository.enqueueRequested(request);

    expect(first.isDuplicate).toBe(false);
    expect(second.isDuplicate).toBe(true);
    expect(second.action.id).toBe(first.action.id);
    expect(second.event.id).toBe(first.event.id);
    expect(first.action.state).toBe("requested");
    expect(
      await repository.listEvents(tenantId, request.actionId),
    ).toMatchObject([
      { eventType: "requested", eventKey: "requested:email-welcome-1" },
    ]);
    expect(await outbox.listUnconsumed(tenantId, 10)).toHaveLength(1);
  });

  it("rejects an idempotency replay with changed semantic request data", async () => {
    const repository = new InMemoryExternalActionsRepository(
      new InMemoryOutboxRepository(),
    );
    await repository.enqueueRequested(request);

    await expect(
      repository.enqueueRequested({
        ...request,
        requestPayload: { ...request.requestPayload, text: "Changed copy" },
      }),
    ).rejects.toBeInstanceOf(ExternalActionConflictError);
  });

  it("uses a canonical digest independent of object key ordering", () => {
    expect(externalActionRequestDigest(request)).toBe(
      externalActionRequestDigest({
        ...request,
        requestPayload: {
          text: "Welcome to GrowthOS.",
          subject: "Welcome",
          to: ["buyer@example.com"],
          channel: "email",
        },
      }),
    );
  });

  it("leases dispatch, records a receipt, and preserves lifecycle audit events", async () => {
    const outbox = new InMemoryOutboxRepository();
    let now = new Date("2026-07-19T12:00:00.000Z");
    const repository = new InMemoryExternalActionsRepository(outbox, () => now);
    await repository.enqueueRequested(request);

    const claim = await repository.claimDispatch({
      tenantId,
      actionId: request.actionId,
      idempotencyKey: request.idempotencyKey,
      leaseOwner: "worker-a",
      leaseDurationMs: 30_000,
    });
    expect(claim.disposition).toBe("claimed");
    if (claim.disposition !== "claimed") throw new Error("expected lease");

    now = new Date("2026-07-19T12:00:01.000Z");
    const dispatched = await repository.recordDispatchAccepted({
      tenantId,
      actionId: request.actionId,
      idempotencyKey: request.idempotencyKey,
      leaseOwner: "worker-a",
      receipt: {
        httpStatus: 202,
        body: { accepted: true },
        workflowId: "workflow-1",
        executionId: "execution-1",
      },
    });

    expect(dispatched).toMatchObject({
      state: "dispatched",
      dispatchAttempts: 1,
      workflowId: "workflow-1",
      executionId: "execution-1",
      dispatchReceipt: { http_status: 202, body: { accepted: true } },
    });
    const audit = await repository.listEvents(tenantId, request.actionId);
    expect(audit.map((event) => event.eventType)).toEqual([
      "requested",
      "dispatch_started",
      "dispatch_accepted",
    ]);
    expect(
      (await outbox.listUnconsumed(tenantId, 10)).map(
        (event) => event.eventType,
      ),
    ).toContain("external_action.dispatched.v1");
  });

  it("persists retry timing and emits a durable incident for permanent dispatch failure", async () => {
    const outbox = new InMemoryOutboxRepository();
    let now = new Date("2026-07-19T12:00:00.000Z");
    const repository = new InMemoryExternalActionsRepository(outbox, () => now);
    await repository.enqueueRequested(request);
    await repository.claimDispatch({
      tenantId,
      actionId: request.actionId,
      idempotencyKey: request.idempotencyKey,
      leaseOwner: "worker-a",
      leaseDurationMs: 30_000,
    });

    const retry = await repository.scheduleDispatchRetry({
      tenantId,
      actionId: request.actionId,
      idempotencyKey: request.idempotencyKey,
      leaseOwner: "worker-a",
      retryAfterMs: 60_000,
      errorMessage: "n8n unavailable",
    });
    expect(retry.state).toBe("retry_scheduled");
    expect(retry.nextRetryAt?.toISOString()).toBe("2026-07-19T12:01:00.000Z");

    const deferred = await repository.claimDispatch({
      tenantId,
      actionId: request.actionId,
      idempotencyKey: request.idempotencyKey,
      leaseOwner: "worker-b",
      leaseDurationMs: 30_000,
    });
    expect(deferred.disposition).toBe("deferred");

    now = new Date("2026-07-19T12:01:00.000Z");
    const reclaimed = await repository.claimDispatch({
      tenantId,
      actionId: request.actionId,
      idempotencyKey: request.idempotencyKey,
      leaseOwner: "worker-b",
      leaseDurationMs: 30_000,
    });
    expect(reclaimed.disposition).toBe("claimed");

    const failed = await repository.failDispatch({
      tenantId,
      actionId: request.actionId,
      idempotencyKey: request.idempotencyKey,
      leaseOwner: "worker-b",
      errorCode: "HTTP_400",
      errorMessage: "n8n rejected the request",
    });
    expect(failed).toMatchObject({
      state: "failed",
      dispatchAttempts: 2,
      lastErrorCode: "HTTP_400",
    });
    expect(
      (await outbox.listUnconsumed(tenantId, 20)).map(
        (event) => event.eventType,
      ),
    ).toEqual(
      expect.arrayContaining([
        "external_action.retry_scheduled.v1",
        "external_action.failed.v1",
        "incident.opened.v1",
      ]),
    );
  });

  it("applies a signed callback outcome exactly once and rejects an unknown action", async () => {
    const outbox = new InMemoryOutboxRepository();
    const repository = new InMemoryExternalActionsRepository(outbox);
    await repository.enqueueRequested(request);

    const first = await repository.recordOutcome({
      tenantId,
      actionId: request.actionId,
      idempotencyKey: request.idempotencyKey,
      callbackId: "callback-1",
      status: "completed",
      executionId: "execution-1",
      providerReference: "mail_123",
      outcome: { delivered: true, messageId: "mail_123" },
    });
    const duplicate = await repository.recordOutcome({
      tenantId,
      actionId: request.actionId,
      idempotencyKey: request.idempotencyKey,
      callbackId: "callback-1",
      status: "completed",
      outcome: { delivered: true },
    });

    expect(first).toMatchObject({
      isDuplicate: false,
      action: {
        state: "completed",
        executionId: "execution-1",
        outcome: { delivered: true, messageId: "mail_123" },
      },
    });
    expect(duplicate).toMatchObject({
      isDuplicate: true,
      action: { state: "completed" },
    });
    expect(
      (await outbox.listUnconsumed(tenantId, 10)).map(
        (event) => event.eventType,
      ),
    ).toContain("external_action.completed.v1");
    await expect(
      repository.recordOutcome({
        tenantId,
        actionId: "unknown-action",
        idempotencyKey: request.idempotencyKey,
        callbackId: "callback-unknown",
        status: "completed",
      }),
    ).rejects.toBeInstanceOf(ExternalActionNotFoundError);
  });
});
