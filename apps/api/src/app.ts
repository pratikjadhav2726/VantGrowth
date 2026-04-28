import type { PaperclipClientPort } from "@growthos/adapter";
import { PaperclipClient, paperclipConfigFromEnv } from "@growthos/adapter";
import {
  RestateHttpWorkflowClient,
  type RestateWorkflowClientPort,
  motionScoringInputSchema,
  restateConfigFromEnv,
  scoreMotions,
} from "@growthos/core";
import {
  type OutboxRepository,
  PostgresOutboxRepository,
  createPgPoolFromEnv,
} from "@growthos/db";
import { Hono } from "hono";
import { mapErrorToResponse } from "./error-middleware.js";
import { createCommandRoutes } from "./routes/commands.js";
import { createPaperclipRoutes } from "./routes/paperclip.js";
import { createWorkflowRoutes } from "./routes/workflows.js";

export interface AppDependencies {
  paperclipClient?: PaperclipClientPort;
  outboxRepository?: OutboxRepository;
  restateWorkflowClient?: RestateWorkflowClientPort;
  runtimeCallbackSecret?: string;
}

const resolvePaperclipClient = (
  deps: AppDependencies,
): PaperclipClientPort | null => {
  if (deps.paperclipClient) return deps.paperclipClient;

  const baseUrl = process.env.PAPERCLIP_BASE_URL;
  const token = process.env.PAPERCLIP_SERVICE_TOKEN;
  if (!baseUrl || !token) return null;

  return new PaperclipClient(
    paperclipConfigFromEnv({
      PAPERCLIP_BASE_URL: baseUrl,
      PAPERCLIP_SERVICE_TOKEN: token,
      PAPERCLIP_TIMEOUT_MS: process.env.PAPERCLIP_TIMEOUT_MS,
    }),
  );
};

const resolveOutboxRepository = (
  deps: AppDependencies,
): OutboxRepository | null => {
  if (deps.outboxRepository) return deps.outboxRepository;
  if (!process.env.DATABASE_URL) return null;

  return new PostgresOutboxRepository(createPgPoolFromEnv(), {
    actorKind: "system",
  });
};

const resolveRestateWorkflowClient = (
  deps: AppDependencies,
): RestateWorkflowClientPort | null => {
  if (deps.restateWorkflowClient) return deps.restateWorkflowClient;
  const config = restateConfigFromEnv();
  if (!config) return null;
  return new RestateHttpWorkflowClient(config);
};

const resolveRuntimeCallbackSecret = (deps: AppDependencies): string | null =>
  deps.runtimeCallbackSecret ?? process.env.RESTATE_CALLBACK_SECRET ?? null;

export const createApp = (deps: AppDependencies = {}): Hono => {
  const app = new Hono();
  app.onError((error, c) => mapErrorToResponse(error, c));

  app.get("/health", (c) =>
    c.json({
      ok: true,
      service: "@growthos/api",
    }),
  );

  app.post("/v1/motions/score", async (c) => {
    const payload = motionScoringInputSchema.parse(await c.req.json());
    const result = scoreMotions(payload);
    return c.json(result, 202);
  });

  app.route(
    "/v1/commands",
    createCommandRoutes({ outboxRepository: resolveOutboxRepository(deps) }),
  );
  app.route(
    "/v1/paperclip",
    createPaperclipRoutes({ paperclipClient: resolvePaperclipClient(deps) }),
  );
  app.route(
    "/v1/workflows",
    createWorkflowRoutes({
      outboxRepository: resolveOutboxRepository(deps),
      restateWorkflowClient: resolveRestateWorkflowClient(deps),
      runtimeCallbackSecret: resolveRuntimeCallbackSecret(deps),
    }),
  );

  return app;
};
