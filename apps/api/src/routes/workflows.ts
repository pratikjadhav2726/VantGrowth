import {
  type RestateWorkflowClientPort,
  createRestateHelloWorkflowOutboxCommand,
  createTenantProvisioningWorkflowOutboxCommand,
  restateHelloWorkflowInputSchema,
  tenantProvisioningWorkflowInputSchema,
} from "@growthos/core";
import type { OutboxRepository } from "@growthos/db";
import { Hono } from "hono";
import { ServiceUnavailableError } from "../http-errors.js";

export interface WorkflowRouteDependencies {
  outboxRepository: OutboxRepository | null;
  restateWorkflowClient: RestateWorkflowClientPort | null;
}

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

  return route;
};
