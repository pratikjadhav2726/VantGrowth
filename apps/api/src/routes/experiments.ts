/**
 * Authenticated, tenant-scoped experiment control-plane APIs.
 *
 * The caller's tenant is derived exclusively from `X-Tenant-Id`; request
 * bodies never carry a tenant identifier. Lifecycle writes use the durable
 * `ExperimentRepository`, whose Postgres implementation also applies tenant
 * RLS inside every transaction.
 *
 * Routes mounted by app.ts:
 *   POST /v1/experiments
 *   GET  /v1/experiments
 *   GET  /v1/experiments/:id
 *   POST /v1/experiments/:id/transition
 *   POST /v1/experiments/:id/assignments
 *   GET  /v1/experiments/:id/observations
 *   POST /v1/experiments/:id/observations
 *   POST /v1/outcomes
 */

import {
  type ExperimentAssignmentRecord,
  type ExperimentObservationRecord,
  type ExperimentRecord,
  type ExperimentRepository,
  type ExperimentStatus,
  assignExperimentParamsSchema,
  createExperimentParamsSchema,
  experimentStatusSchema,
  recordExperimentObservationParamsSchema,
  tenantIdSchema,
  transitionExperimentParamsSchema,
} from "@growthos/db";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from "../http-errors.js";

const MAX_LIST_LIMIT = 100;

const experimentTransitions: Readonly<
  Record<ExperimentStatus, readonly ExperimentStatus[]>
> = {
  draft: ["running", "abandoned"],
  running: ["paused", "concluded", "abandoned"],
  paused: ["running", "abandoned"],
  concluded: ["promoted", "abandoned"],
  abandoned: [],
  promoted: ["rolled_back"],
  rolled_back: [],
};

/** JSON API timestamps are RFC 3339 strings; repositories use Date values. */
const apiDateSchema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value));

/**
 * Start from the database contracts to avoid request/persistence drift, then
 * make each HTTP object strict. In particular, a body-level `tenantId` is a
 * validation error rather than a silently ignored spoofing attempt.
 */
const createExperimentRequestSchema = createExperimentParamsSchema
  .extend({ startedAt: apiDateSchema.optional() })
  .strict();

const transitionExperimentRequestSchema = transitionExperimentParamsSchema
  .extend({
    fromStatus: experimentStatusSchema,
    toStatus: experimentStatusSchema,
    endedAt: apiDateSchema.optional(),
  })
  .strict();

const assignExperimentRequestSchema = assignExperimentParamsSchema
  .omit({ experimentId: true })
  .extend({ exposedAt: apiDateSchema.optional() })
  .strict();

const recordNestedObservationRequestSchema =
  recordExperimentObservationParamsSchema
    .omit({ experimentId: true })
    .extend({ observedAt: apiDateSchema.optional() })
    .strict();

const recordOutcomeRequestSchema = recordExperimentObservationParamsSchema
  .extend({ observedAt: apiDateSchema.optional() })
  .strict();

const resourceIdSchema = z.string().uuid();
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).default(50),
});
const observationListQuerySchema = listQuerySchema.extend({
  metricName: z.string().trim().min(1).max(255).optional(),
});

export interface ExperimentRouteDependencies {
  experimentRepository: ExperimentRepository | null;
}

type ParsedBody<TSchema extends z.ZodTypeAny> =
  | { data: z.infer<TSchema> }
  | { response: Response };

const parseJsonBody = async <TSchema extends z.ZodTypeAny>(
  c: Context,
  schema: TSchema,
): Promise<ParsedBody<TSchema>> => {
  const body = await c.req.json().catch(() => undefined);
  if (body === undefined) {
    return {
      response: c.json({ error: "Request body must be valid JSON" }, 400),
    };
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return {
      response: c.json(
        {
          error: "Request validation failed",
          details: parsed.error.flatten().fieldErrors,
        },
        400,
      ),
    };
  }

  return { data: parsed.data };
};

const requireTenantId = (
  c: Context,
): { tenantId: string } | { response: Response } => {
  const value = c.req.header("X-Tenant-Id");
  if (!value) {
    return {
      response: c.json({ error: "X-Tenant-Id header is required" }, 400),
    };
  }

  const parsed = tenantIdSchema.safeParse(value);
  if (!parsed.success) {
    return {
      response: c.json({ error: "X-Tenant-Id must be a valid UUID" }, 400),
    };
  }

  return { tenantId: parsed.data };
};

const requireExperimentId = (
  c: Context,
): { experimentId: string } | { response: Response } => {
  const parsed = resourceIdSchema.safeParse(c.req.param("id"));
  if (!parsed.success) {
    return {
      response: c.json({ error: "Experiment id must be a valid UUID" }, 400),
    };
  }
  return { experimentId: parsed.data };
};

const requireRepository = (
  repository: ExperimentRepository | null,
): ExperimentRepository => {
  if (!repository) {
    throw new ServiceUnavailableError(
      "Experiment repository is not configured. Set DATABASE_URL.",
    );
  }
  return repository;
};

const setPrivateNoStore = (c: Context): void => {
  c.header("Cache-Control", "private, no-store");
};

const serializeExperiment = (record: ExperimentRecord) => ({
  ...record,
  startedAt: record.startedAt?.toISOString() ?? null,
  endedAt: record.endedAt?.toISOString() ?? null,
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
});

const serializeAssignment = (record: ExperimentAssignmentRecord) => ({
  ...record,
  assignedAt: record.assignedAt.toISOString(),
  exposedAt: record.exposedAt?.toISOString() ?? null,
  createdAt: record.createdAt.toISOString(),
});

const serializeObservation = (record: ExperimentObservationRecord) => ({
  ...record,
  observedAt: record.observedAt.toISOString(),
  createdAt: record.createdAt.toISOString(),
});

const isLegalTransition = (
  fromStatus: ExperimentStatus,
  toStatus: ExperimentStatus,
): boolean => experimentTransitions[fromStatus].includes(toStatus);

const canAssign = (status: ExperimentStatus): boolean =>
  status === "draft" || status === "running";

const canRecordObservation = (status: ExperimentStatus): boolean =>
  status === "running" ||
  status === "concluded" ||
  status === "promoted" ||
  status === "rolled_back";

/**
 * The persistence layer exposes expected lifecycle/integrity rejections as
 * ordinary Errors, so recognize only the explicit domain messages. All other
 * errors continue to the global handler as a 500 instead of being mislabeled
 * as a caller conflict (for example, a database outage).
 */
const isExpectedExperimentConflict = (error: unknown): error is Error =>
  error instanceof Error &&
  [
    "Experiment does not exist for this tenant.",
    "Assignments are only allowed for draft or running experiments.",
    "Observations require a running or completed experiment.",
    "Observation assignment does not match the experiment unit.",
    "Illegal experiment transition:",
  ].some((message) => error.message.startsWith(message));

const getTenantExperiment = async (
  repository: ExperimentRepository,
  tenantId: string,
  experimentId: string,
): Promise<ExperimentRecord> => {
  const experiment = await repository.getById(tenantId, experimentId);
  if (!experiment) {
    // Deliberately indistinguishable from a non-existent resource: callers
    // cannot learn whether another tenant owns an experiment id.
    throw new NotFoundError("Experiment was not found.");
  }
  return experiment;
};

const parseListQuery = (
  c: Context,
): { limit: number } | { response: Response } => {
  const parsed = listQuerySchema.safeParse({ limit: c.req.query("limit") });
  if (!parsed.success) {
    return {
      response: c.json(
        { error: `limit must be an integer between 1 and ${MAX_LIST_LIMIT}` },
        400,
      ),
    };
  }
  return parsed.data;
};

const parseObservationListQuery = (
  c: Context,
): { limit: number; metricName?: string } | { response: Response } => {
  const parsed = observationListQuerySchema.safeParse({
    limit: c.req.query("limit"),
    metricName: c.req.query("metricName"),
  });
  if (!parsed.success) {
    return {
      response: c.json(
        {
          error: `limit must be an integer between 1 and ${MAX_LIST_LIMIT}; metricName must be non-empty when provided`,
        },
        400,
      ),
    };
  }
  return parsed.data.metricName === undefined
    ? { limit: parsed.data.limit }
    : { limit: parsed.data.limit, metricName: parsed.data.metricName };
};

/** Experiment lifecycle, assignment, and observation routes. */
export const createExperimentRoutes = (
  deps: ExperimentRouteDependencies,
): Hono => {
  const route = new Hono();

  route.post("/", async (c) => {
    setPrivateNoStore(c);
    const tenant = requireTenantId(c);
    if ("response" in tenant) return tenant.response;
    const body = await parseJsonBody(c, createExperimentRequestSchema);
    if ("response" in body) return body.response;
    const repository = requireRepository(deps.experimentRepository);

    const experiment = await repository.create(tenant.tenantId, body.data);
    return c.json(
      {
        tenantId: tenant.tenantId,
        experiment: serializeExperiment(experiment),
      },
      201,
    );
  });

  route.get("/", async (c) => {
    setPrivateNoStore(c);
    const tenant = requireTenantId(c);
    if ("response" in tenant) return tenant.response;
    const query = parseListQuery(c);
    if ("response" in query) return query.response;
    const repository = requireRepository(deps.experimentRepository);

    const experiments = await repository.listRecent(
      tenant.tenantId,
      query.limit,
    );
    return c.json({
      tenantId: tenant.tenantId,
      items: experiments.map(serializeExperiment),
      total: experiments.length,
    });
  });

  route.get("/:id", async (c) => {
    setPrivateNoStore(c);
    const tenant = requireTenantId(c);
    if ("response" in tenant) return tenant.response;
    const id = requireExperimentId(c);
    if ("response" in id) return id.response;
    const repository = requireRepository(deps.experimentRepository);

    const experiment = await getTenantExperiment(
      repository,
      tenant.tenantId,
      id.experimentId,
    );
    return c.json({
      tenantId: tenant.tenantId,
      experiment: serializeExperiment(experiment),
    });
  });

  route.post("/:id/transition", async (c) => {
    setPrivateNoStore(c);
    const tenant = requireTenantId(c);
    if ("response" in tenant) return tenant.response;
    const id = requireExperimentId(c);
    if ("response" in id) return id.response;
    const body = await parseJsonBody(c, transitionExperimentRequestSchema);
    if ("response" in body) return body.response;
    const repository = requireRepository(deps.experimentRepository);

    const current = await getTenantExperiment(
      repository,
      tenant.tenantId,
      id.experimentId,
    );
    if (current.status !== body.data.fromStatus) {
      throw new ConflictError(
        `Experiment is currently ${current.status}; expected ${body.data.fromStatus}.`,
      );
    }
    if (!isLegalTransition(body.data.fromStatus, body.data.toStatus)) {
      throw new ConflictError(
        `Illegal experiment transition: ${body.data.fromStatus} -> ${body.data.toStatus}.`,
      );
    }

    const transitioned = await repository.transition(
      tenant.tenantId,
      id.experimentId,
      body.data.fromStatus,
      body.data.toStatus,
      {
        winner: body.data.winner,
        confidence: body.data.confidence,
        endedAt: body.data.endedAt,
      },
    );
    if (!transitioned) {
      // A compare-and-swap race occurred after the pre-read; do not overwrite
      // a concurrent lifecycle decision.
      throw new ConflictError(
        "Experiment changed before the requested transition could be applied.",
      );
    }

    return c.json({
      tenantId: tenant.tenantId,
      experiment: serializeExperiment(transitioned),
    });
  });

  route.post("/:id/assignments", async (c) => {
    setPrivateNoStore(c);
    const tenant = requireTenantId(c);
    if ("response" in tenant) return tenant.response;
    const id = requireExperimentId(c);
    if ("response" in id) return id.response;
    const body = await parseJsonBody(c, assignExperimentRequestSchema);
    if ("response" in body) return body.response;
    const repository = requireRepository(deps.experimentRepository);

    const experiment = await getTenantExperiment(
      repository,
      tenant.tenantId,
      id.experimentId,
    );
    if (!canAssign(experiment.status)) {
      throw new ConflictError(
        "Assignments are only allowed for draft or running experiments.",
      );
    }

    try {
      const result = await repository.assign(tenant.tenantId, {
        ...body.data,
        experimentId: id.experimentId,
      });
      return c.json(
        {
          tenantId: tenant.tenantId,
          assignment: serializeAssignment(result.assignment),
          idempotent: result.isExisting,
        },
        result.isExisting ? 200 : 201,
      );
    } catch (error) {
      if (isExpectedExperimentConflict(error)) {
        throw new ConflictError(error.message);
      }
      throw error;
    }
  });

  route.get("/:id/observations", async (c) => {
    setPrivateNoStore(c);
    const tenant = requireTenantId(c);
    if ("response" in tenant) return tenant.response;
    const id = requireExperimentId(c);
    if ("response" in id) return id.response;
    const query = parseObservationListQuery(c);
    if ("response" in query) return query.response;
    const repository = requireRepository(deps.experimentRepository);

    await getTenantExperiment(repository, tenant.tenantId, id.experimentId);
    const observations = await repository.listObservations(
      tenant.tenantId,
      id.experimentId,
      query,
    );
    return c.json({
      tenantId: tenant.tenantId,
      experimentId: id.experimentId,
      items: observations.map(serializeObservation),
      total: observations.length,
    });
  });

  route.post("/:id/observations", async (c) => {
    setPrivateNoStore(c);
    const tenant = requireTenantId(c);
    if ("response" in tenant) return tenant.response;
    const id = requireExperimentId(c);
    if ("response" in id) return id.response;
    const body = await parseJsonBody(c, recordNestedObservationRequestSchema);
    if ("response" in body) return body.response;
    const repository = requireRepository(deps.experimentRepository);

    const experiment = await getTenantExperiment(
      repository,
      tenant.tenantId,
      id.experimentId,
    );
    if (!canRecordObservation(experiment.status)) {
      throw new ConflictError(
        "Observations require a running or completed experiment.",
      );
    }

    try {
      const observation = await repository.recordObservation(tenant.tenantId, {
        ...body.data,
        experimentId: id.experimentId,
      });
      return c.json(
        {
          tenantId: tenant.tenantId,
          observation: serializeObservation(observation),
        },
        201,
      );
    } catch (error) {
      if (isExpectedExperimentConflict(error)) {
        throw new ConflictError(error.message);
      }
      throw error;
    }
  });

  return route;
};

/**
 * Outcome capture is exposed separately for collectors that are not concerned
 * with the surrounding experiment UI. It uses the repository's semantic
 * `recordOutcome` operation, preserving tenant-scoped idempotency.
 */
export const createOutcomeRoutes = (
  deps: ExperimentRouteDependencies,
): Hono => {
  const route = new Hono();

  route.post("/", async (c) => {
    setPrivateNoStore(c);
    const tenant = requireTenantId(c);
    if ("response" in tenant) return tenant.response;
    const body = await parseJsonBody(c, recordOutcomeRequestSchema);
    if ("response" in body) return body.response;
    const repository = requireRepository(deps.experimentRepository);

    const experiment = await getTenantExperiment(
      repository,
      tenant.tenantId,
      body.data.experimentId,
    );
    if (!canRecordObservation(experiment.status)) {
      throw new ConflictError(
        "Observations require a running or completed experiment.",
      );
    }

    try {
      const observation = await repository.recordOutcome(
        tenant.tenantId,
        body.data,
      );
      return c.json(
        {
          tenantId: tenant.tenantId,
          observation: serializeObservation(observation),
        },
        201,
      );
    } catch (error) {
      if (isExpectedExperimentConflict(error)) {
        throw new ConflictError(error.message);
      }
      throw error;
    }
  });

  return route;
};
