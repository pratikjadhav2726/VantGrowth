/**
 * ApprovalFeedbackRepository — Phase 1 / S5
 *
 * Records founder approval decisions (approve, reject, edit) for generated
 * artifacts.  Each row is an immutable decision event — history is preserved
 * and the UI reads the latest per (tenant, issueId, outputType).
 *
 * Used by:
 *   - `POST /v1/approvals/decide` (API route)
 *   - `LearningWorker.process()` (consumes decisions as learning signals)
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { tenantIdSchema } from "./contracts.js";
import type { GrowthOsDb } from "./db.js";
import { type ApprovalFeedback, approvalFeedback } from "./schema.js";
import type { TenantContext } from "./tenant-context.js";

type TxClient = Parameters<Parameters<GrowthOsDb["transaction"]>[0]>[0];

const setTenantContext = (
  tx: TxClient,
  tenantId: string,
  ctx: Omit<TenantContext, "tenantId">,
) =>
  tx.execute(
    sql`SELECT
      set_config('app.tenant_id',  ${tenantId},               true),
      set_config('app.actor_id',   ${""},                     true),
      set_config('app.actor_kind', ${ctx.actorKind ?? "system"}, true)`,
  );

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export const recordApprovalParamsSchema = z.object({
  tenantId: tenantIdSchema,
  issueId: z.string().uuid(),
  outputType: z.string().min(1),
  action: z.enum([
    "approved",
    "edited_then_approved",
    "rejected",
    "auto_approved",
  ]),
  editDistance: z.number().min(0).max(1).optional(),
  reviewerNote: z.string().optional(),
  learnOptIn: z.boolean().default(true),
});

export type RecordApprovalParams = z.infer<typeof recordApprovalParamsSchema>;

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface ApprovalFeedbackRepository {
  /**
   * Inserts a new approval decision row.
   * There is no uniqueness constraint — multiple decisions can exist for the
   * same (issueId, outputType) to support re-reviews; the UI surfaces the
   * most recent.
   */
  record(params: RecordApprovalParams): Promise<ApprovalFeedback>;

  /**
   * Returns the most recent approval decisions for the tenant, ordered by
   * `createdAt` descending, filtered by optional outputType.
   */
  listRecent(
    tenantId: string,
    limit: number,
    outputType?: string,
  ): Promise<ApprovalFeedback[]>;
}

// ---------------------------------------------------------------------------
// InMemoryApprovalFeedbackRepository
// ---------------------------------------------------------------------------

export class InMemoryApprovalFeedbackRepository
  implements ApprovalFeedbackRepository
{
  private readonly rows: ApprovalFeedback[] = [];
  private nextId = 1;

  async record(params: RecordApprovalParams): Promise<ApprovalFeedback> {
    const parsed = recordApprovalParamsSchema.parse(params);
    const row: ApprovalFeedback = {
      id: `00000000-0000-4000-8000-${String(this.nextId++).padStart(12, "0")}`,
      tenantId: parsed.tenantId,
      issueId: parsed.issueId,
      outputType: parsed.outputType,
      action: parsed.action,
      editDistance: parsed.editDistance?.toString() ?? null,
      rubricFailures: [],
      reviewerNote: parsed.reviewerNote ?? null,
      learnOptIn: parsed.learnOptIn,
      createdAt: new Date(),
    };
    this.rows.push(row);
    return row;
  }

  async listRecent(
    tenantId: string,
    limit: number,
    outputType?: string,
  ): Promise<ApprovalFeedback[]> {
    const tid = tenantIdSchema.parse(tenantId);
    return [...this.rows]
      .filter(
        (r) =>
          r.tenantId === tid &&
          (outputType === undefined || r.outputType === outputType),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }
}

// ---------------------------------------------------------------------------
// PostgresApprovalFeedbackRepository
// ---------------------------------------------------------------------------

export class PostgresApprovalFeedbackRepository
  implements ApprovalFeedbackRepository
{
  constructor(
    private readonly db: GrowthOsDb,
    private readonly ctx: Omit<TenantContext, "tenantId"> = {
      actorKind: "system",
    },
  ) {}

  async record(params: RecordApprovalParams): Promise<ApprovalFeedback> {
    const parsed = recordApprovalParamsSchema.parse(params);
    const tenantId = tenantIdSchema.parse(parsed.tenantId);

    const values: typeof approvalFeedback.$inferInsert = {
      tenantId,
      issueId: parsed.issueId,
      outputType: parsed.outputType,
      action: parsed.action,
      learnOptIn: parsed.learnOptIn,
    };
    if (parsed.editDistance !== undefined) {
      values.editDistance = parsed.editDistance.toString();
    }
    if (parsed.reviewerNote !== undefined) {
      values.reviewerNote = parsed.reviewerNote;
    }

    let result: ApprovalFeedback | undefined;
    await this.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId, this.ctx);
      [result] = await tx.insert(approvalFeedback).values(values).returning();
    });

    if (!result) throw new Error("Failed to insert approval_feedback row");
    return result;
  }

  async listRecent(
    tenantId: string,
    limit: number,
    outputType?: string,
  ): Promise<ApprovalFeedback[]> {
    const tid = tenantIdSchema.parse(tenantId);

    return this.db.transaction(async (tx) => {
      await setTenantContext(tx, tid, this.ctx);
      const conditions = [eq(approvalFeedback.tenantId, tid)];
      if (outputType !== undefined) {
        conditions.push(eq(approvalFeedback.outputType, outputType));
      }
      return tx
        .select()
        .from(approvalFeedback)
        .where(and(...conditions))
        .orderBy(desc(approvalFeedback.createdAt))
        .limit(limit);
    });
  }
}
