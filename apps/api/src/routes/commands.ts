import { eventOutboxCommandSchema } from "@growthos/core";
import type { OutboxRepository } from "@growthos/db";
import { Hono } from "hono";
import { ServiceUnavailableError } from "../http-errors.js";

export interface CommandRouteDependencies {
  outboxRepository: OutboxRepository | null;
}

export const createCommandRoutes = (deps: CommandRouteDependencies): Hono => {
  const route = new Hono();

  route.post("/outbox", async (c) => {
    if (!deps.outboxRepository) {
      throw new ServiceUnavailableError(
        "Outbox repository is not configured. Set DATABASE_URL.",
      );
    }

    const payload = eventOutboxCommandSchema.parse(await c.req.json());
    const event = await deps.outboxRepository.enqueue(payload);

    return c.json(
      {
        accepted: true,
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
