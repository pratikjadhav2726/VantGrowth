import type { PaperclipClientPort } from "@growthos/adapter";
import { PaperclipClient, paperclipConfigFromEnv } from "@growthos/adapter";
import {
  RestateHttpWorkflowClient,
  type RestateWorkflowClientPort,
  restateConfigFromEnv,
} from "@growthos/core";
import {
  type ApprovalFeedbackRepository,
  type ExperimentRepository,
  type ExternalActionsRepository,
  type GrowthOsDb,
  type LearningProposalRepository,
  type MotionStackRepository,
  type OutboxRepository,
  PostgresApprovalFeedbackRepository,
  PostgresComponentHealthRepository,
  PostgresExperimentRepository,
  PostgresExternalActionsRepository,
  PostgresIncidentRepository,
  PostgresLearningProposalRepository,
  PostgresMotionStackRepository,
  PostgresOutboxRepository,
  PostgresSignalEventsRepository,
  PostgresTenantSettingsRepository,
  PostgresWorkflowRunRepository,
  type SignalEventsRepository,
  type TenantSettingsRepository,
  type WorkflowRunRepository,
  createDbFromEnv,
} from "@growthos/db";
import {
  BufferedLlmCallLogSink,
  ClickHouseLlmCallLogSink,
  type LlmCallRunner,
  OpenAiLlmCallRunner,
} from "@growthos/llm-harness";
import { N8nDispatchClient } from "@growthos/n8n";
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
import {
  type ComponentHealthControlPlaneRepository,
  type IncidentControlPlaneRepository,
  createControlPlaneRoutes,
} from "./routes/control-plane.js";
import { createDigestRoutes } from "./routes/digest.js";
import {
  createExperimentRoutes,
  createOutcomeRoutes,
} from "./routes/experiments.js";
import { createLearningProposalRoutes } from "./routes/learning-proposals.js";
import { createMotionRoutes } from "./routes/motion.js";
import { createMotionsRoutes } from "./routes/motions.js";
import { createN8nRoutes } from "./routes/n8n.js";
import { createPaperclipRoutes } from "./routes/paperclip.js";
import { createSettingsRoutes } from "./routes/settings.js";
import { createSignalRoutes } from "./routes/signals.js";
import { createWorkflowRoutes } from "./routes/workflows.js";

export const log = createLogger("growthos.api");

/**
 * One API process must share one database pool across all route groups.
 * Creating a repository per route with `createDbFromEnv()` would otherwise
 * allocate a separate pg pool for outbox, signals, approvals, settings, and
 * the adaptive control plane. The resolver remains lazy so tests that inject
 * repositories never create an unused database client.
 */
type DatabaseResolver = () => GrowthOsDb | null;

const createSharedDatabaseResolver = (): DatabaseResolver => {
  let resolved = false;
  let database: GrowthOsDb | null = null;

  return () => {
    if (!resolved) {
      database = process.env.DATABASE_URL ? createDbFromEnv() : null;
      resolved = true;
    }
    return database;
  };
};

export interface AppDependencies {
  paperclipClient?: PaperclipClientPort;
  outboxRepository?: OutboxRepository;
  workflowRunRepository?: WorkflowRunRepository;
  restateWorkflowClient?: RestateWorkflowClientPort;
  runtimeCallbackSecret?: string;
  signalEventsRepository?: SignalEventsRepository;
  externalActionsRepository?: ExternalActionsRepository | null;
  approvalFeedbackRepository?: ApprovalFeedbackRepository;
  motionStackRepository?: MotionStackRepository;
  tenantSettingsRepository?: TenantSettingsRepository;
  /**
   * Optional adaptive control-plane read models. They are injected in tests
   * and resolved from the durable stores in production.
   */
  componentHealthRepository?: ComponentHealthControlPlaneRepository;
  incidentRepository?: IncidentControlPlaneRepository;
  /**
   * Durable experiment lifecycle/evidence store. It also provides the
   * narrower status summary used by the control-plane dashboard.
   */
  experimentRepository?: ExperimentRepository | null;
  /** Durable learning proposal store and founder-approval handoff. */
  learningProposalRepository?: LearningProposalRepository | null;
  /**
   * Optional LLM runner for `POST /v1/signals/grade`. When omitted, resolves
   * from `OPENAI_API_KEY` via `OpenAiLlmCallRunner.fromEnv()`. Pass `null` in
   * tests to force unconfigured behaviour.
   */
  llmCallRunner?: LlmCallRunner | null;
  n8nSharedSecret?: string | null;
  n8nDispatchClient?: N8nDispatchClient | null;
  n8nDispatchWebhookUrl?: string | null;
  n8nDispatchResultCallbackUrl?: string | null;
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
  getDatabase: DatabaseResolver,
): OutboxRepository | null => {
  if (deps.outboxRepository) return deps.outboxRepository;
  const db = getDatabase();
  if (!db) return null;

  return new PostgresOutboxRepository(db, {
    actorKind: "system",
  });
};

const resolveWorkflowRunRepository = (
  deps: AppDependencies,
  getDatabase: DatabaseResolver,
): WorkflowRunRepository | null => {
  if (deps.workflowRunRepository) return deps.workflowRunRepository;
  const db = getDatabase();
  if (!db) return null;

  return new PostgresWorkflowRunRepository(db, {
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
  getDatabase: DatabaseResolver,
): SignalEventsRepository | null => {
  if (deps.signalEventsRepository) return deps.signalEventsRepository;
  const db = getDatabase();
  if (!db) return null;
  return new PostgresSignalEventsRepository(db);
};

const resolveExternalActionsRepository = (
  deps: AppDependencies,
  getDatabase: DatabaseResolver,
): ExternalActionsRepository | null => {
  if (deps.externalActionsRepository !== undefined) {
    return deps.externalActionsRepository;
  }
  const db = getDatabase();
  if (!db) return null;
  return new PostgresExternalActionsRepository(db, {
    actorKind: "system",
  });
};

const resolveApprovalFeedbackRepository = (
  deps: AppDependencies,
  getDatabase: DatabaseResolver,
): ApprovalFeedbackRepository | null => {
  if (deps.approvalFeedbackRepository) return deps.approvalFeedbackRepository;
  const db = getDatabase();
  if (!db) return null;
  return new PostgresApprovalFeedbackRepository(db);
};

const resolveMotionStackRepository = (
  deps: AppDependencies,
  getDatabase: DatabaseResolver,
): MotionStackRepository | null => {
  if (deps.motionStackRepository) return deps.motionStackRepository;
  const db = getDatabase();
  if (!db) return null;
  return new PostgresMotionStackRepository(db);
};

const resolveTenantSettingsRepository = (
  deps: AppDependencies,
  getDatabase: DatabaseResolver,
): TenantSettingsRepository | null => {
  if (deps.tenantSettingsRepository) return deps.tenantSettingsRepository;
  const db = getDatabase();
  if (!db) return null;
  return new PostgresTenantSettingsRepository(db);
};

interface ResolvedAdaptiveControlPlaneRepositories {
  componentHealthRepository: ComponentHealthControlPlaneRepository | null;
  incidentRepository: IncidentControlPlaneRepository | null;
  experimentRepository: ExperimentRepository | null;
  learningProposalRepository: LearningProposalRepository | null;
}

/**
 * Builds the adaptive read models from one shared database handle. These
 * repositories are read independently by the command center but should not
 * create one connection pool per panel.
 */
const resolveAdaptiveControlPlaneRepositories = (
  deps: AppDependencies,
  getDatabase: DatabaseResolver,
): ResolvedAdaptiveControlPlaneRepositories => {
  const allInjected =
    deps.componentHealthRepository !== undefined &&
    deps.incidentRepository !== undefined &&
    deps.experimentRepository !== undefined &&
    deps.learningProposalRepository !== undefined;

  if (allInjected) {
    return {
      componentHealthRepository: deps.componentHealthRepository ?? null,
      incidentRepository: deps.incidentRepository ?? null,
      experimentRepository: deps.experimentRepository ?? null,
      learningProposalRepository: deps.learningProposalRepository ?? null,
    };
  }

  const db = getDatabase();
  if (!db) {
    return {
      componentHealthRepository: deps.componentHealthRepository ?? null,
      incidentRepository: deps.incidentRepository ?? null,
      experimentRepository: deps.experimentRepository ?? null,
      learningProposalRepository: deps.learningProposalRepository ?? null,
    };
  }
  const context = { actorKind: "system" } as const;

  return {
    componentHealthRepository:
      deps.componentHealthRepository ??
      new PostgresComponentHealthRepository(db, context),
    incidentRepository:
      deps.incidentRepository ?? new PostgresIncidentRepository(db, context),
    experimentRepository:
      deps.experimentRepository !== undefined
        ? deps.experimentRepository
        : new PostgresExperimentRepository(db, context),
    learningProposalRepository:
      deps.learningProposalRepository !== undefined
        ? deps.learningProposalRepository
        : new PostgresLearningProposalRepository(db, context),
  };
};

const resolveLogSink = (): BufferedLlmCallLogSink | undefined => {
  if (!process.env.CLICKHOUSE_URL && !process.env.CLICKHOUSE_HTTP_URL) {
    return undefined;
  }
  try {
    return new BufferedLlmCallLogSink({
      sink: ClickHouseLlmCallLogSink.fromEnv(),
      maxBatchSize: 50,
      flushIntervalMs: 15_000,
    });
  } catch {
    log.warn(
      "ClickHouse log sink misconfigured — LLM calls will not be logged",
    );
    return undefined;
  }
};

const resolveLlmCallRunner = (deps: AppDependencies): LlmCallRunner | null => {
  if (deps.llmCallRunner !== undefined) {
    return deps.llmCallRunner;
  }
  if (process.env.OPENAI_API_KEY) {
    const logSink = resolveLogSink();
    return OpenAiLlmCallRunner.fromEnv(
      logSink !== undefined ? { logSink } : {},
    );
  }
  return null;
};

const resolveN8nSharedSecret = (deps: AppDependencies): string | null =>
  deps.n8nSharedSecret ?? process.env.N8N_SHARED_SECRET ?? null;

const resolveN8nDispatchWebhookUrl = (deps: AppDependencies): string | null =>
  deps.n8nDispatchWebhookUrl ?? process.env.N8N_DISPATCH_WEBHOOK_URL ?? null;

const resolveN8nDispatchResultCallbackUrl = (
  deps: AppDependencies,
): string | null =>
  deps.n8nDispatchResultCallbackUrl ??
  process.env.N8N_DISPATCH_RESULT_CALLBACK_URL ??
  null;

const resolveN8nDispatchClient = (
  deps: AppDependencies,
): N8nDispatchClient | null => {
  if (deps.n8nDispatchClient !== undefined) return deps.n8nDispatchClient;

  const webhookUrl = resolveN8nDispatchWebhookUrl(deps);
  if (!webhookUrl) return null;

  const timeoutMs = process.env.N8N_TIMEOUT_MS
    ? Number(process.env.N8N_TIMEOUT_MS)
    : 10_000;
  const sharedSecret = resolveN8nSharedSecret(deps);

  try {
    return new N8nDispatchClient({
      webhookUrl,
      timeoutMs:
        Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10_000,
      ...(sharedSecret ? { sharedSecret } : {}),
    });
  } catch {
    log.warn(
      "n8n dispatch client misconfigured; dispatch route will be unavailable",
    );
    return null;
  }
};

export const createApp = (deps: AppDependencies = {}): Hono => {
  const app = new Hono();
  const getDatabase = createSharedDatabaseResolver();
  const paperclipClient = resolvePaperclipClient(deps);
  const adaptiveControlPlaneRepositories =
    resolveAdaptiveControlPlaneRepositories(deps, getDatabase);
  const outboxRepository = resolveOutboxRepository(deps, getDatabase);
  const workflowRunRepository = resolveWorkflowRunRepository(deps, getDatabase);
  const signalEventsRepository = resolveSignalEventsRepository(
    deps,
    getDatabase,
  );
  const externalActionsRepository = resolveExternalActionsRepository(
    deps,
    getDatabase,
  );
  const approvalFeedbackRepository = resolveApprovalFeedbackRepository(
    deps,
    getDatabase,
  );
  const motionStackRepository = resolveMotionStackRepository(deps, getDatabase);
  const tenantSettingsRepository = resolveTenantSettingsRepository(
    deps,
    getDatabase,
  );
  const paperclipRequired = process.env.GROWTHOS_REQUIRE_PAPERCLIP === "true";
  const paperclipConnected = paperclipClient !== null;
  const paperclipStatus = paperclipConnected
    ? "connected"
    : paperclipRequired
      ? "required_but_disconnected"
      : "optional_disconnected";

  // ── Observability middleware (spans + metrics on every request) ────────────
  // No-op when OTel SDK has not been initialised (unit tests, local dev).
  app.use(
    "*",
    createHttpMiddleware(getTracer("growthos.api"), getMeter("growthos.api")),
  );

  app.onError((error, c) => mapErrorToResponse(error, c));

  // ── API token auth on mutation routes and sensitive control-plane reads ───
  // GET /health, GET /v1/motion, and GET /v1/approvals remain public.
  // GET /v1/control-plane/* is deliberately protected because it exposes
  // tenant operational posture, incident counts, and policy-enforcement state.
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
  // Founder operational data is sensitive even though it is read-only. The
  // server-side web client supplies this token; local development remains
  // permissive until GROWTHOS_API_SERVICE_TOKEN is configured.
  app.use("/v1/control-plane/*", requireToken);
  // Experiment definitions, assignments, and outcome evidence are sensitive
  // tenant control-plane data, so protect both reads and writes.
  app.use("/v1/experiments", requireToken);
  app.use("/v1/experiments/*", requireToken);
  app.use("/v1/outcomes", requireToken);
  app.use("/v1/outcomes/*", requireToken);
  app.use("/v1/learning-proposals", requireToken);
  app.use("/v1/learning-proposals/*", requireToken);
  app.use("/v1/n8n/dispatch", requireToken);
  app.use("/v1/paperclip/*", requireToken);
  app.use("/v1/workflows/hello", requireToken);
  app.use("/v1/workflows/tenant-provisioning", requireToken);
  app.use("/v1/digest/send", requireToken);
  // GET /v1/settings is public (non-sensitive UI prefs); PATCH requires token.
  app.use("/v1/settings", async (c, next) => {
    if (c.req.method === "PATCH") return requireToken(c, next);
    return next();
  });

  app.get("/health", (c) =>
    c.json({
      ok: !paperclipRequired || paperclipConnected,
      service: "@growthos/api",
      version: process.env.npm_package_version ?? "0.1.0",
      dependencies: {
        paperclip: {
          required: paperclipRequired,
          connected: paperclipConnected,
          status: paperclipStatus,
        },
      },
    }),
  );

  app.get("/v1/system/status", (c) =>
    c.json({
      paperclip: {
        required: paperclipRequired,
        connected: paperclipConnected,
        status: paperclipStatus,
      },
    }),
  );

  app.route(
    "/v1/motions",
    createMotionsRoutes({
      motionStackRepository,
    }),
  );
  app.route("/v1/commands", createCommandRoutes({ outboxRepository }));
  app.route("/v1/paperclip", createPaperclipRoutes({ paperclipClient }));
  app.route(
    "/v1/workflows",
    createWorkflowRoutes({
      outboxRepository,
      workflowRunRepository,
      restateWorkflowClient: resolveRestateWorkflowClient(deps),
      runtimeCallbackSecret: resolveRuntimeCallbackSecret(deps),
    }),
  );
  app.route(
    "/v1/signals",
    createSignalRoutes({
      signalEventsRepository,
      llmCallRunner: resolveLlmCallRunner(deps),
    }),
  );
  app.route(
    "/v1/n8n",
    createN8nRoutes({
      signalEventsRepository,
      outboxRepository,
      externalActionsRepository,
      n8nSharedSecret: resolveN8nSharedSecret(deps),
      n8nDispatchClient: resolveN8nDispatchClient(deps),
      n8nDispatchWebhookUrl: resolveN8nDispatchWebhookUrl(deps),
      n8nDispatchResultCallbackUrl: resolveN8nDispatchResultCallbackUrl(deps),
    }),
  );
  app.route(
    "/v1/approvals",
    createApprovalRoutes({
      outboxRepository,
      approvalFeedbackRepository,
    }),
  );
  app.route(
    "/v1/motion",
    createMotionRoutes({
      motionStackRepository,
    }),
  );
  app.route(
    "/v1/digest",
    createDigestRoutes({
      approvalFeedbackRepository,
      outboxRepository,
      motionStackRepository,
      signalEventsRepository,
    }),
  );
  app.route(
    "/v1/control-plane",
    createControlPlaneRoutes({
      outboxRepository,
      signalEventsRepository,
      approvalFeedbackRepository,
      motionStackRepository,
      ...adaptiveControlPlaneRepositories,
    }),
  );
  app.route(
    "/v1/experiments",
    createExperimentRoutes({
      experimentRepository:
        adaptiveControlPlaneRepositories.experimentRepository,
    }),
  );
  app.route(
    "/v1/outcomes",
    createOutcomeRoutes({
      experimentRepository:
        adaptiveControlPlaneRepositories.experimentRepository,
    }),
  );
  app.route(
    "/v1/learning-proposals",
    createLearningProposalRoutes({
      learningProposalRepository:
        adaptiveControlPlaneRepositories.learningProposalRepository,
    }),
  );
  app.route(
    "/v1/settings",
    createSettingsRoutes({
      tenantSettingsRepository,
    }),
  );

  return app;
};
