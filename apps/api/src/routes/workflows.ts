import { createHmac, timingSafeEqual } from "node:crypto";
import {
  type RestateWorkflowClientPort,
  createRestateHelloWorkflowOutboxCommand,
  createTenantProvisioningCompletedOutboxCommand,
  createTenantProvisioningProgressOutboxCommand,
  createTenantProvisioningWorkflowOutboxCommand,
  restateHelloWorkflowInputSchema,
  tenantProvisioningRuntimeCallbackSchema,
  tenantProvisioningWorkflowInputSchema,
} from "@growthos/core";
import type { OutboxRepository } from "@growthos/db";
import { Hono } from "hono";
import { ServiceUnavailableError, UnauthorizedError } from "../http-errors.js";

export interface WorkflowRouteDependencies {
  outboxRepository: OutboxRepository | null;
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
    const progressCommand =
      createTenantProvisioningProgressOutboxCommand(payload);
    await deps.outboxRepository.enqueue(progressCommand);
    const command = createTenantProvisioningCompletedOutboxCommand(payload);
    const event = await deps.outboxRepository.enqueue(command);

    return c.json(
      {
        accepted: true,
        workflowId: payload.workflowId,
        callbackId: payload.callbackId,
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
