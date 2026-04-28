import { createHmac, timingSafeEqual } from "node:crypto";
import {
  type RestateWorkflowClientPort,
  callbackTypeToState,
  createRestateHelloWorkflowOutboxCommand,
  createTenantProvisioningCompletedOutboxCommand,
  createTenantProvisioningFailedOutboxCommand,
  createTenantProvisioningProgressOutboxCommand,
  createTenantProvisioningWorkflowOutboxCommand,
  restateHelloWorkflowInputSchema,
  tenantProvisioningRuntimeCallbackSchema,
  tenantProvisioningWorkflowInputSchema,
  validateWorkflowTransition,
} from "@growthos/core";
import type { OutboxRepository, WorkflowRunRepository } from "@growthos/db";
import { Hono } from "hono";
import {
  ConflictError,
  ServiceUnavailableError,
  UnauthorizedError,
} from "../http-errors.js";

export interface WorkflowRouteDependencies {
  outboxRepository: OutboxRepository | null;
  workflowRunRepository: WorkflowRunRepository | null;
  restateWorkflowClient: RestateWorkflowClientPort | null;
  runtimeCallbackSecret: string | null;
}

const isRuntimeCallbackSignatureValid = (
  secret: string,
  payload: string,
  providedSignature: string | null,
): boolean => {
  if (!providedSignature) return false;
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  const provided = providedSignature.trim();
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
};

export const createWorkflowRoutes = (deps: WorkflowRouteDependencies): Hono => {
  const route = new Hono();

  route.post("/hello", async (c) => {
    if (!deps.outboxRepository) {
      throw new ServiceUnavailableError(
        "Outbox repository is not configured. Set DATABASE_URL.",
      );
    }

    const payload = restateHelloWorkflowInputSchema.parse(await c.req.json());
    const command = createRestateHelloWorkflowOutboxCommand(payload);
    const event = await deps.outboxRepository.enqueue(command);
    void deps.restateWorkflowClient
      ?.startHelloWorkflow(payload)
      .catch((error) => {
        console.error("restate hello workflow dispatch failed", error);
      });

    return c.json(
      {
        accepted: true,
        workflowId: payload.workflowId,
        trackingId: `${event.tenantId}:${event.idempotencyKey}`,
        eventId: event.id,
        eventType: event.eventType,
        enqueuedAt: event.createdAt.toISOString(),
      },
      202,
    );
  });

  route.post("/tenant-provisioning", async (c) => {
    if (!deps.outboxRepository) {
      throw new ServiceUnavailableError(
        "Outbox repository is not configured. Set DATABASE_URL.",
      );
    }

    const payload = tenantProvisioningWorkflowInputSchema.parse(
      await c.req.json(),
    );

    // Durably record that this workflow was requested. Idempotent on dedupeKey.
    await deps.workflowRunRepository?.upsertRequested(
      payload.tenantId,
      payload.workflowId,
      payload.dedupeKey,
    );

    const command = createTenantProvisioningWorkflowOutboxCommand(payload);
    const event = await deps.outboxRepository.enqueue(command);
    void deps.restateWorkflowClient
      ?.startTenantProvisioningWorkflow(payload)
      .catch((error) => {
        console.error(
          "restate tenant provisioning workflow dispatch failed",
          error,
        );
      });

    return c.json(
      {
        accepted: true,
        workflowId: payload.workflowId,
        trackingId: `${event.tenantId}:${event.idempotencyKey}`,
        eventId: event.id,
        eventType: event.eventType,
        enqueuedAt: event.createdAt.toISOString(),
      },
      202,
    );
  });

  route.post("/runtime-callbacks/tenant-provisioning", async (c) => {
    if (!deps.outboxRepository) {
      throw new ServiceUnavailableError(
        "Outbox repository is not configured. Set DATABASE_URL.",
      );
    }

    const rawPayload = await c.req.text();
    if (deps.runtimeCallbackSecret) {
      const signature = c.req.header("x-restate-signature") ?? null;
      if (
        !isRuntimeCallbackSignatureValid(
          deps.runtimeCallbackSecret,
          rawPayload,
          signature,
        )
      ) {
        throw new UnauthorizedError("Invalid runtime callback signature");
      }
    }

    const payload = tenantProvisioningRuntimeCallbackSchema.parse(
      JSON.parse(rawPayload),
    );

    const targetState = callbackTypeToState(payload.callbackType);

    if (deps.workflowRunRepository) {
      // Load the durable prior state. A missing run defaults to "requested"
      // (first callback after a trigger that skipped persistence).
      const run = await deps.workflowRunRepository.getByWorkflowId(
        payload.tenantId,
        payload.workflowId,
      );
      const priorState = run?.state ?? "requested";

      // Validate the transition is legal for the current stored state.
      const transition = validateWorkflowTransition(priorState, targetState);
      if (!transition.ok) {
        throw new ConflictError(transition.reason, {
          priorState,
          callbackType: payload.callbackType,
          targetState,
        });
      }

      // Attempt atomic CAS transition. If it returns null, another callback
      // won the race; treat as a conflict to avoid duplicate terminal events.
      const updated = await deps.workflowRunRepository.transitionState(
        payload.tenantId,
        payload.workflowId,
        priorState,
        targetState,
        payload.failureCode,
      );

      if (!updated && priorState !== targetState) {
        throw new ConflictError(
          `Concurrent state transition detected for workflow '${payload.workflowId}'. Retry with latest state.`,
          { priorState, targetState },
        );
      }
    } else {
      // No state store configured: validate using the most-permissive prior.
      // This is the safe degraded path for environments without DATABASE_URL.
      const transition = validateWorkflowTransition("in_progress", targetState);
      if (!transition.ok) {
        throw new ConflictError(transition.reason, {
          callbackType: payload.callbackType,
          targetState,
        });
      }
    }

    // Always emit a progress event so consumers can reconstruct the execution
    // timeline regardless of the terminal callback type.
    const progressCommand =
      createTenantProvisioningProgressOutboxCommand(payload);
    await deps.outboxRepository.enqueue(progressCommand);

    // Emit the terminal event determined by callbackType.
    let terminalCommand: ReturnType<
      | typeof createTenantProvisioningCompletedOutboxCommand
      | typeof createTenantProvisioningFailedOutboxCommand
    >;
    if (payload.callbackType === "failed") {
      terminalCommand = createTenantProvisioningFailedOutboxCommand(payload);
    } else {
      terminalCommand = createTenantProvisioningCompletedOutboxCommand(payload);
    }
    const event = await deps.outboxRepository.enqueue(terminalCommand);

    return c.json(
      {
        accepted: true,
        workflowId: payload.workflowId,
        callbackId: payload.callbackId,
        callbackType: payload.callbackType,
        targetState,
        trackingId: `${event.tenantId}:${event.idempotencyKey}`,
        eventId: event.id,
        eventType: event.eventType,
        enqueuedAt: event.createdAt.toISOString(),
      },
      202,
    );
  });

  route.post("/runtime-callbacks/tenant-provisioning/progress", async (c) => {
    if (!deps.outboxRepository) {
      throw new ServiceUnavailableError(
        "Outbox repository is not configured. Set DATABASE_URL.",
      );
    }

    const rawPayload = await c.req.text();
    if (deps.runtimeCallbackSecret) {
      const signature = c.req.header("x-restate-signature") ?? null;
      if (
        !isRuntimeCallbackSignatureValid(
          deps.runtimeCallbackSecret,
          rawPayload,
          signature,
        )
      ) {
        throw new UnauthorizedError("Invalid runtime callback signature");
      }
    }

    const payload = tenantProvisioningRuntimeCallbackSchema.parse({
      ...JSON.parse(rawPayload),
      callbackType: "progress",
    });

    const command = createTenantProvisioningProgressOutboxCommand(payload);
    const event = await deps.outboxRepository.enqueue(command);

    return c.json(
      {
        accepted: true,
        workflowId: payload.workflowId,
        callbackId: payload.callbackId,
        callbackType: "progress",
        targetState: "in_progress",
        trackingId: `${event.tenantId}:${event.idempotencyKey}`,
        eventId: event.id,
        eventType: event.eventType,
        enqueuedAt: event.createdAt.toISOString(),
      },
      202,
    );
  });

  return route;
};
