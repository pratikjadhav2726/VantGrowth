/**
 * /v1/approvals — founder approval queue.
 *
 * Routes:
 *   GET  /v1/approvals         — lists pending outbox events awaiting review
 *   POST /v1/approvals/decide  — records an approve/reject/edit decision
 *
 * The approval queue surfaces `event_outbox` rows whose `eventType` matches
 * the requested `outputType` filter and for which no `approval_feedback` row
 * exists yet (pending = not yet acted on).
 *
 * The `POST /decide` endpoint is idempotent per `issueId + outputType`:
 * a second decision for the same issue is accepted but only the latest row
 * is returned by the GET listing.
 */

import type {
  ApprovalFeedback,
  ApprovalFeedbackRepository,
  OutboxRepository,
} from "@growthos/db";
import { Hono } from "hono";
import { z } from "zod";
import { ServiceUnavailableError } from "../http-errors.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const approvalDecisionSchema = z.object({
  /** Paperclip issueId the artifact is associated with */
  issueId: z.string().uuid(),
  /** Artifact kind, e.g. "blog_draft.v1", "content_brief.v1" */
  outputType: z.string().min(1).max(100),
  /** Founder's decision */
  action: z.enum(["approved", "edited_then_approved", "rejected"]),
  /**
   * Fraction of the output that was edited before approval.
   * Only relevant for `edited_then_approved`. [0, 1]
   */
  editDistance: z.number().min(0).max(1).optional(),
  /** Free-text reviewer note for learning signal */
  reviewerNote: z.string().max(1000).optional(),
  /** Opt-in to use this decision for playbook learning. Default: true */
  learnOptIn: z.boolean().optional(),
});

export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

// ---------------------------------------------------------------------------
// Route dependencies
// ---------------------------------------------------------------------------

export interface ApprovalRouteDependencies {
  outboxRepository: OutboxRepository | null;
  approvalFeedbackRepository: ApprovalFeedbackRepository | null;
}

const issueIdKeys = [
  "issueId",
  "issue_id",
  "draft_id",
  "draftId",
  "brief_id",
  "briefId",
  "content_id",
  "contentId",
] as const;

const extractIssueId = (payload: Record<string, unknown>): string | null => {
  for (const key of issueIdKeys) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
};

const learningSignalPayload = (feedback: ApprovalFeedback) => ({
  tenantId: feedback.tenantId,
  learningId: feedback.id,
  dedupeKey: `approval-feedback:${feedback.id}`,
  source: "founder_approval",
  issueId: feedback.issueId,
  outputType: feedback.outputType,
  action: feedback.action,
  editDistance:
    feedback.editDistance === null ? null : Number(feedback.editDistance),
  rubricFailures: feedback.rubricFailures,
  ...(feedback.reviewerNote ? { reviewerNote: feedback.reviewerNote } : {}),
  learnOptIn: feedback.learnOptIn,
});

type AtomicLearningFeedbackRepository = ApprovalFeedbackRepository & {
  recordAndEnqueueLearningSignal(params: {
    tenantId: string;
    issueId: string;
    outputType: string;
    action: "approved" | "edited_then_approved" | "rejected";
    editDistance?: number;
    reviewerNote?: string;
    learnOptIn: boolean;
  }): Promise<ApprovalFeedback>;
};

const supportsAtomicLearningSignal = (
  repository: ApprovalFeedbackRepository,
): repository is AtomicLearningFeedbackRepository =>
  "recordAndEnqueueLearningSignal" in repository &&
  typeof repository.recordAndEnqueueLearningSignal === "function";

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export const createApprovalRoutes = (deps: ApprovalRouteDependencies): Hono => {
  const route = new Hono();

  /**
   * GET /v1/approvals
   *
   * Query params:
   *   outputType  — filter by artifact kind (default: "blog_draft.v1")
   *   limit       — max items (default: 20, max: 100)
   *
   * Headers:
   *   X-Tenant-Id: <uuid>  (required)
   *
   * Response 200:
   *   { items: ApprovalQueueItem[], total: number }
   */
  route.get("/", async (c) => {
    if (!deps.outboxRepository) {
      throw new ServiceUnavailableError(
        "Outbox repository is not configured. Set DATABASE_URL.",
      );
    }

    const tenantId = c.req.header("X-Tenant-Id");
    if (!tenantId) {
      return c.json({ error: "X-Tenant-Id header is required" }, 400);
    }

    const outputType = c.req.query("outputType") ?? "blog_draft.v1";
    const limitRaw = Number(c.req.query("limit") ?? "20");
    const limit = Math.min(
      Math.max(1, Number.isNaN(limitRaw) ? 20 : limitRaw),
      100,
    );

    const events = await deps.outboxRepository.listByEventType(
      tenantId,
      outputType,
      limit * 2,
    );
    const decisions = deps.approvalFeedbackRepository
      ? await deps.approvalFeedbackRepository.listRecent(
          tenantId,
          1000,
          outputType,
        )
      : [];
    const decidedIssueIds = new Set(decisions.map((d) => d.issueId));
    const matching = events
      .filter((e) => {
        const issueId = extractIssueId(e.payload);
        return issueId === null || !decidedIssueIds.has(issueId);
      })
      .slice(0, limit);

    const items = matching.map((e) => ({
      eventId: e.id,
      tenantId: e.tenantId,
      outputType: e.eventType,
      payload: e.payload,
      enqueuedAt: e.createdAt.toISOString(),
      status: "pending" as const,
    }));

    return c.json({ items, total: items.length }, 200);
  });

  /**
   * POST /v1/approvals/decide
   *
   * Headers:
   *   X-Tenant-Id: <uuid>  (required)
   *
   * Body: ApprovalDecision (JSON)
   *
   * Response 202:
   *   { accepted: true, feedbackId: string, issueId: string, action: string }
   */
  route.post("/decide", async (c) => {
    if (!deps.approvalFeedbackRepository) {
      throw new ServiceUnavailableError(
        "Approval feedback repository is not configured. Set DATABASE_URL.",
      );
    }

    const tenantId = c.req.header("X-Tenant-Id");
    if (!tenantId) {
      return c.json({ error: "X-Tenant-Id header is required" }, 400);
    }

    const body = approvalDecisionSchema.parse(await c.req.json());
    if (!deps.outboxRepository) {
      throw new ServiceUnavailableError(
        "Outbox repository is not configured. Set DATABASE_URL.",
      );
    }

    const recordParams = {
      tenantId,
      issueId: body.issueId,
      outputType: body.outputType,
      action: body.action,
      ...(body.editDistance !== undefined
        ? { editDistance: body.editDistance }
        : {}),
      ...(body.reviewerNote !== undefined
        ? { reviewerNote: body.reviewerNote }
        : {}),
      learnOptIn: body.learnOptIn ?? true,
    };

    const feedback = supportsAtomicLearningSignal(
      deps.approvalFeedbackRepository,
    )
      ? await deps.approvalFeedbackRepository.recordAndEnqueueLearningSignal(
          recordParams,
        )
      : await deps.approvalFeedbackRepository.record(recordParams);

    // In-memory/adapter repositories do not expose a shared database
    // transaction. Production Postgres uses the atomic branch above; this
    // fallback preserves the same contract for tests and alternate adapters.
    if (!supportsAtomicLearningSignal(deps.approvalFeedbackRepository)) {
      const payload = learningSignalPayload(feedback);
      await deps.outboxRepository.enqueue({
        tenantId,
        eventType: "learning.signal.v1",
        idempotencyKey: payload.dedupeKey,
        payload,
      });
    }

    return c.json(
      {
        accepted: true,
        feedbackId: feedback.id,
        issueId: feedback.issueId,
        action: feedback.action,
        tenantId: feedback.tenantId,
        decidedAt: feedback.createdAt.toISOString(),
      },
      202,
    );
  });

  return route;
};
