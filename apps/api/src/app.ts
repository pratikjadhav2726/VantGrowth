import type { PaperclipClientPort } from "@growthos/adapter";
import { PaperclipClient, paperclipConfigFromEnv } from "@growthos/adapter";
import {
  RestateHttpWorkflowClient,
  type RestateWorkflowClientPort,
  restateConfigFromEnv,
} from "@growthos/core";
import {
  type ApprovalFeedbackRepository,
  type MotionStackRepository,
  type OutboxRepository,
  PostgresApprovalFeedbackRepository,
  PostgresMotionStackRepository,
  PostgresOutboxRepository,
  PostgresSignalEventsRepository,
  PostgresWorkflowRunRepository,
  type SignalEventsRepository,
  type WorkflowRunRepository,
  createDbFromEnv,
} from "@growthos/db";
import { type LlmCallRunner, OpenAiLlmCallRunner } from "@growthos/llm-harness";
import {
  createHttpMiddleware,
  createLogger,
  getMeter,
  getTracer,
} from "@growthos/observability";
import { Hono } from "hono";
import { createApiTokenMiddleware } from "./auth-middleware.js";
import { mapErrorToResponse } from "./error-middleware.js";
import { createApprovalRoutes } from "./routes/approvals.js";
import { createCommandRoutes } from "./routes/commands.js";
import { createDigestRoutes } from "./routes/digest.js";
import { createMotionRoutes } from "./routes/motion.js";
import { createMotionsRoutes } from "./routes/motions.js";
import { createPaperclipRoutes } from "./routes/paperclip.js";
import { createSignalRoutes } from "./routes/signals.js";
import { createWorkflowRoutes } from "./routes/workflows.js";

export const log = createLogger("growthos.api");

export interface AppDependencies {
  paperclipClient?: PaperclipClientPort;
  outboxRepository?: OutboxRepository;
  workflowRunRepository?: WorkflowRunRepository;
  restateWorkflowClient?: RestateWorkflowClientPort;
  runtimeCallbackSecret?: string;
  signalEventsRepository?: SignalEventsRepository;
  approvalFeedbackRepository?: ApprovalFeedbackRepository;
  motionStackRepository?: MotionStackRepository;
  /**
   * Optional LLM runner for `POST /v1/signals/grade`. When omitted, resolves
   * from `OPENAI_API_KEY` via `OpenAiLlmCallRunner.fromEnv()`. Pass `null` in
   * tests to force unconfigured behaviour.
   */
  llmCallRunner?: LlmCallRunner | null;
  /**
   * When set, all mutation routes enforce `Authorization: Bearer <token>`.
   * When null/undefined, the API runs in permissive mode (dev/CI default).
   * Resolved from `GROWTHOS_API_SERVICE_TOKEN` env when not injected.
   */
  apiServiceToken?: string | null;
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

  return new PostgresOutboxRepository(createDbFromEnv(), {
    actorKind: "system",
  });
};

const resolveWorkflowRunRepository = (
  deps: AppDependencies,
): WorkflowRunRepository | null => {
  if (deps.workflowRunRepository) return deps.workflowRunRepository;
  if (!process.env.DATABASE_URL) return null;

  return new PostgresWorkflowRunRepository(createDbFromEnv(), {
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

const resolveSignalEventsRepository = (
  deps: AppDependencies,
): SignalEventsRepository | null => {
  if (deps.signalEventsRepository) return deps.signalEventsRepository;
  if (!process.env.DATABASE_URL) return null;
  return new PostgresSignalEventsRepository(createDbFromEnv());
};

const resolveApprovalFeedbackRepository = (
  deps: AppDependencies,
): ApprovalFeedbackRepository | null => {
  if (deps.approvalFeedbackRepository) return deps.approvalFeedbackRepository;
  if (!process.env.DATABASE_URL) return null;
  return new PostgresApprovalFeedbackRepository(createDbFromEnv());
};

const resolveMotionStackRepository = (
  deps: AppDependencies,
): MotionStackRepository | null => {
  if (deps.motionStackRepository) return deps.motionStackRepository;
  if (!process.env.DATABASE_URL) return null;
  return new PostgresMotionStackRepository(createDbFromEnv());
};

const resolveLlmCallRunner = (deps: AppDependencies): LlmCallRunner | null => {
  if (deps.llmCallRunner !== undefined) {
    return deps.llmCallRunner;
  }
  if (process.env.OPENAI_API_KEY) {
    return OpenAiLlmCallRunner.fromEnv();
  }
  return null;
};

export const createApp = (deps: AppDependencies = {}): Hono => {
  const app = new Hono();

  // ── Observability middleware (spans + metrics on every request) ────────────
  // No-op when OTel SDK has not been initialised (unit tests, local dev).
  app.use(
    "*",
    createHttpMiddleware(getTracer("growthos.api"), getMeter("growthos.api")),
  );

  app.onError((error, c) => mapErrorToResponse(error, c));

  // ── API token auth on all mutation routes ─────────────────────────────────
  // GET /health, GET /v1/motion, GET /v1/approvals remain public.
  // POST /v1/workflows/runtime-callbacks/* uses HMAC (handled inside the route).
  // When GROWTHOS_API_SERVICE_TOKEN is unset (or apiServiceToken is null) the
  // middleware is permissive — existing tests and local dev work unchanged.
  const apiToken =
    deps.apiServiceToken !== undefined
      ? deps.apiServiceToken
      : (process.env.GROWTHOS_API_SERVICE_TOKEN ?? null);
  const requireToken = createApiTokenMiddleware({ serviceToken: apiToken });

  app.use("/v1/motions/*", requireToken);
  app.use("/v1/approvals/decide", requireToken);
  // Both exact and wildcard are needed: /v1/signals (POST /) and /v1/signals/* (POST /grade).
  app.use("/v1/signals", requireToken);
  app.use("/v1/signals/*", requireToken);
  app.use("/v1/commands/*", requireToken);
  app.use("/v1/paperclip/*", requireToken);
  app.use("/v1/workflows/hello", requireToken);
  app.use("/v1/workflows/tenant-provisioning", requireToken);
  app.use("/v1/digest/send", requireToken);

  app.get("/health", (c) =>
    c.json({
      ok: true,
      service: "@growthos/api",
      version: process.env.npm_package_version ?? "0.1.0",
    }),
  );

  app.route(
    "/v1/motions",
    createMotionsRoutes({
      motionStackRepository: resolveMotionStackRepository(deps),
    }),
  );
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
      workflowRunRepository: resolveWorkflowRunRepository(deps),
      restateWorkflowClient: resolveRestateWorkflowClient(deps),
      runtimeCallbackSecret: resolveRuntimeCallbackSecret(deps),
    }),
  );
  app.route(
    "/v1/signals",
    createSignalRoutes({
      signalEventsRepository: resolveSignalEventsRepository(deps),
      llmCallRunner: resolveLlmCallRunner(deps),
    }),
  );
  app.route(
    "/v1/approvals",
    createApprovalRoutes({
      outboxRepository: resolveOutboxRepository(deps),
      approvalFeedbackRepository: resolveApprovalFeedbackRepository(deps),
    }),
  );
  app.route(
    "/v1/motion",
    createMotionRoutes({
      motionStackRepository: resolveMotionStackRepository(deps),
    }),
  );
  app.route(
    "/v1/digest",
    createDigestRoutes({
      approvalFeedbackRepository: resolveApprovalFeedbackRepository(deps),
      outboxRepository: resolveOutboxRepository(deps),
      motionStackRepository: resolveMotionStackRepository(deps),
    }),
  );

  return app;
};
