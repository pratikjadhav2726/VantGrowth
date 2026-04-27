import { Hono } from "hono";
import { motionScoringInputSchema, scoreMotions } from "@growthos/core";
import type { PaperclipClientPort } from "@growthos/adapter";
import { PaperclipClient, paperclipConfigFromEnv } from "@growthos/adapter";
import { createPgPoolFromEnv, PostgresOutboxRepository, type OutboxRepository } from "@growthos/db";
import { mapErrorToResponse } from "./error-middleware.js";
import { createCommandRoutes } from "./routes/commands.js";
import { createPaperclipRoutes } from "./routes/paperclip.js";

export interface AppDependencies {
  paperclipClient?: PaperclipClientPort;
  outboxRepository?: OutboxRepository;
}

const resolvePaperclipClient = (deps: AppDependencies): PaperclipClientPort | null => {
  if (deps.paperclipClient) return deps.paperclipClient;

  const baseUrl = process.env.PAPERCLIP_BASE_URL;
  const token = process.env.PAPERCLIP_SERVICE_TOKEN;
  if (!baseUrl || !token) return null;

  return new PaperclipClient(
    paperclipConfigFromEnv({
      PAPERCLIP_BASE_URL: baseUrl,
      PAPERCLIP_SERVICE_TOKEN: token,
      PAPERCLIP_TIMEOUT_MS: process.env.PAPERCLIP_TIMEOUT_MS
    })
  );
};

const resolveOutboxRepository = (deps: AppDependencies): OutboxRepository | null => {
  if (deps.outboxRepository) return deps.outboxRepository;
  if (!process.env.DATABASE_URL) return null;

  return new PostgresOutboxRepository(createPgPoolFromEnv(), {
    actorKind: "system"
  });
};

export const createApp = (deps: AppDependencies = {}): Hono => {
  const app = new Hono();
  app.onError((error, c) => mapErrorToResponse(error, c));

  app.get("/health", (c) =>
    c.json({
      ok: true,
      service: "@growthos/api"
    })
  );

  app.post("/v1/motions/score", async (c) => {
    const payload = motionScoringInputSchema.parse(await c.req.json());
    const result = scoreMotions(payload);
    return c.json(result, 202);
  });

  app.route("/v1/commands", createCommandRoutes({ outboxRepository: resolveOutboxRepository(deps) }));
  app.route("/v1/paperclip", createPaperclipRoutes({ paperclipClient: resolvePaperclipClient(deps) }));

  return app;
};
