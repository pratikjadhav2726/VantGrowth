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

    // Retrieve unconsumed outbox events matching the outputType.
    const events = await deps.outboxRepository.listUnconsumed(tenantId, limit);
    const matching = events.filter((e) => e.eventType === outputType);

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

    const feedback = await deps.approvalFeedbackRepository.record({
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
    });

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
