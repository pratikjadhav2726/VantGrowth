/**
 * Founder-facing learning proposal control plane.
 *
 * Tenant identity comes exclusively from `X-Tenant-Id`. Founder approval uses
 * `LearningProposalRepository.approveAndEnqueue`, which commits the lifecycle
 * transition and `learning.proposal.approved.v1` outbox row in one database
 * transaction. The learning worker then independently re-checks evidence
 * before it promotes any playbook change.
 */

import {
  type LearningProposalRecord,
  type LearningProposalRepository,
  learningProposalStatusSchema,
  tenantIdSchema,
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

const resourceIdSchema = z.string().uuid();
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).default(50),
  status: learningProposalStatusSchema.optional(),
});
const approveRequestSchema = z
  .object({
    /** Auditable human or service identity; never used for tenant selection. */
    approvedBy: z.string().trim().min(1).max(255),
  })
  .strict();

export interface LearningProposalRouteDependencies {
  learningProposalRepository: LearningProposalRepository | null;
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

const requireProposalId = (
  c: Context,
): { proposalId: string } | { response: Response } => {
  const parsed = resourceIdSchema.safeParse(c.req.param("id"));
  if (!parsed.success) {
    return {
      response: c.json(
        { error: "Learning proposal id must be a valid UUID" },
        400,
      ),
    };
  }
  return { proposalId: parsed.data };
};

const requireRepository = (
  repository: LearningProposalRepository | null,
): LearningProposalRepository => {
  if (!repository) {
    throw new ServiceUnavailableError(
      "Learning proposal repository is not configured. Set DATABASE_URL.",
    );
  }
  return repository;
};

const setPrivateNoStore = (c: Context): void => {
  c.header("Cache-Control", "private, no-store");
};

const serializeProposal = (record: LearningProposalRecord) => {
  const {
    // The lease token is a fencing credential for workers, not founder data.
    promotionClaimToken: _promotionClaimToken,
    promotionClaimExpiresAt: _promotionClaimExpiresAt,
    ...publicRecord
  } = record;
  return {
    ...publicRecord,
    humanApprovedAt: record.humanApprovedAt?.toISOString() ?? null,
    evaluatedAt: record.evaluatedAt?.toISOString() ?? null,
    promotedAt: record.promotedAt?.toISOString() ?? null,
    rolledBackAt: record.rolledBackAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
};

/** Lists omit structured evidence/proposal payloads; detail remains available. */
const serializeProposalSummary = (record: LearningProposalRecord) => {
  const serialized = serializeProposal(record);
  const { proposalPayload, evidenceSnapshot, evaluationSnapshot, ...summary } =
    serialized;
  return summary;
};

const getTenantProposal = async (
  repository: LearningProposalRepository,
  tenantId: string,
  proposalId: string,
): Promise<LearningProposalRecord> => {
  const proposal = await repository.getById(tenantId, proposalId);
  if (!proposal) {
    // Cross-tenant IDs intentionally look identical to unknown IDs.
    throw new NotFoundError("Learning proposal was not found.");
  }
  return proposal;
};

const parseListQuery = (
  c: Context,
):
  | { limit: number; status?: z.infer<typeof learningProposalStatusSchema> }
  | { response: Response } => {
  const parsed = listQuerySchema.safeParse({
    limit: c.req.query("limit"),
    status: c.req.query("status"),
  });
  if (!parsed.success) {
    return {
      response: c.json(
        {
          error: `limit must be an integer between 1 and ${MAX_LIST_LIMIT}; status must be a supported learning proposal status`,
        },
        400,
      ),
    };
  }
  return parsed.data.status === undefined
    ? { limit: parsed.data.limit }
    : { limit: parsed.data.limit, status: parsed.data.status };
};

/** Authenticated tenant-scoped proposal list, detail, and approval routes. */
export const createLearningProposalRoutes = (
  deps: LearningProposalRouteDependencies,
): Hono => {
  const route = new Hono();

  route.get("/", async (c) => {
    setPrivateNoStore(c);
    const tenant = requireTenantId(c);
    if ("response" in tenant) return tenant.response;
    const query = parseListQuery(c);
    if ("response" in query) return query.response;
    const repository = requireRepository(deps.learningProposalRepository);

    const proposals = await repository.listRecent(
      tenant.tenantId,
      query.limit,
      query.status,
    );
    return c.json({
      tenantId: tenant.tenantId,
      items: proposals.map(serializeProposalSummary),
      total: proposals.length,
    });
  });

  route.get("/:id", async (c) => {
    setPrivateNoStore(c);
    const tenant = requireTenantId(c);
    if ("response" in tenant) return tenant.response;
    const id = requireProposalId(c);
    if ("response" in id) return id.response;
    const repository = requireRepository(deps.learningProposalRepository);

    const proposal = await getTenantProposal(
      repository,
      tenant.tenantId,
      id.proposalId,
    );
    return c.json({
      tenantId: tenant.tenantId,
      proposal: serializeProposal(proposal),
    });
  });

  route.post("/:id/approve", async (c) => {
    setPrivateNoStore(c);
    const tenant = requireTenantId(c);
    if ("response" in tenant) return tenant.response;
    const id = requireProposalId(c);
    if ("response" in id) return id.response;
    const body = await parseJsonBody(c, approveRequestSchema);
    if ("response" in body) return body.response;
    const repository = requireRepository(deps.learningProposalRepository);

    const proposal = await getTenantProposal(
      repository,
      tenant.tenantId,
      id.proposalId,
    );
    if (proposal.status !== "requires_approval") {
      throw new ConflictError(
        `Learning proposal is currently ${proposal.status}; it cannot be approved.`,
      );
    }

    const result = await repository.approveAndEnqueue(
      tenant.tenantId,
      id.proposalId,
      body.data.approvedBy,
    );
    if (!result) {
      // The status changed between the pre-read and the repository's
      // compare-and-swap update, so a concurrent decision wins safely.
      throw new ConflictError(
        "Learning proposal changed before the approval could be applied.",
      );
    }

    return c.json({
      tenantId: tenant.tenantId,
      proposal: serializeProposal(result.proposal),
      approvalEvent: {
        id: result.outboxEvent.id,
        eventType: result.outboxEvent.eventType,
        idempotencyKey: result.outboxEvent.idempotencyKey,
        createdAt: result.outboxEvent.createdAt.toISOString(),
      },
    });
  });

  return route;
};
