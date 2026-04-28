/**
 * MotionStackRepository — Phase 1 / S5
 *
 * Reads motion scoring data (motion_scores + motion_stack tables) for the
 * API layer and web UI.
 *
 * Write path: `POST /v1/motions/score` → scoreMotions() → direct DB insert
 * (handled separately by the API route or a future scheduler worker).
 *
 * Read path (this module):
 *   - `getLatestScore(tenantId)` — most recent motion_scores row.
 *   - `getLatestStack(tenantId)` — most recent motion_stack row.
 *   - `listRecentScores(tenantId, limit)` — history for trend charts.
 */

import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { tenantIdSchema } from "./contracts.js";
import type { GrowthOsDb } from "./db.js";
import {
  type MotionScore,
  type MotionStack,
  motionScores,
  motionStack,
} from "./schema.js";

type TxClient = Parameters<Parameters<GrowthOsDb["transaction"]>[0]>[0];

const setTenantCtx = (tx: TxClient, tenantId: string) =>
  tx.execute(
    sql`SELECT set_config('app.tenant_id', ${tenantId}, true),
             set_config('app.actor_id', '', true),
             set_config('app.actor_kind', 'system', true)`,
  );

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface MotionOverview {
  latestScore: MotionScore | null;
  latestStack: MotionStack | null;
  recentScores: MotionScore[];
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface MotionStackRepository {
  /** Returns the most recent motion_scores row for the tenant. */
  getLatestScore(tenantId: string): Promise<MotionScore | null>;

  /** Returns the most recent motion_stack row for the tenant. */
  getLatestStack(tenantId: string): Promise<MotionStack | null>;

  /**
   * Returns up to `limit` motion_scores rows ordered newest-first.
   * Used for sparkline / trend rendering on the motion page.
   */
  listRecentScores(tenantId: string, limit: number): Promise<MotionScore[]>;

  /** Convenience: returns latest score + stack + recent history in one call. */
  getOverview(tenantId: string, historyLimit?: number): Promise<MotionOverview>;

  /** Persists a new motion_scores row (upsert-like: always inserts). */
  recordScore(
    params: z.infer<typeof recordMotionScoreParamsSchema>,
  ): Promise<MotionScore>;
}

// ---------------------------------------------------------------------------
// Params schema
// ---------------------------------------------------------------------------

export const recordMotionScoreParamsSchema = z.object({
  tenantId: tenantIdSchema,
  scorerVersion: z.string().min(1),
  scores: z.record(z.number()),
  inputsDigest: z.string().min(1),
  rationale: z.array(z.string()).default([]),
});

export type RecordMotionScoreParams = z.infer<
  typeof recordMotionScoreParamsSchema
>;

// ---------------------------------------------------------------------------
// InMemoryMotionStackRepository
// ---------------------------------------------------------------------------

export class InMemoryMotionStackRepository implements MotionStackRepository {
  private readonly scoreRows: MotionScore[] = [];
  private readonly stackRows: MotionStack[] = [];
  private nextId = 1;

  async getLatestScore(tenantId: string): Promise<MotionScore | null> {
    const tid = tenantIdSchema.parse(tenantId);
    return (
      [...this.scoreRows]
        .filter((r) => r.tenantId === tid)
        .sort((a, b) => b.scoredAt.getTime() - a.scoredAt.getTime())[0] ?? null
    );
  }

  async getLatestStack(tenantId: string): Promise<MotionStack | null> {
    const tid = tenantIdSchema.parse(tenantId);
    return (
      [...this.stackRows]
        .filter((r) => r.tenantId === tid)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ??
      null
    );
  }

  async listRecentScores(
    tenantId: string,
    limit: number,
  ): Promise<MotionScore[]> {
    const tid = tenantIdSchema.parse(tenantId);
    return [...this.scoreRows]
      .filter((r) => r.tenantId === tid)
      .sort((a, b) => b.scoredAt.getTime() - a.scoredAt.getTime())
      .slice(0, limit);
  }

  async getOverview(
    tenantId: string,
    historyLimit = 7,
  ): Promise<MotionOverview> {
    return {
      latestScore: await this.getLatestScore(tenantId),
      latestStack: await this.getLatestStack(tenantId),
      recentScores: await this.listRecentScores(tenantId, historyLimit),
    };
  }

  async recordScore(params: RecordMotionScoreParams): Promise<MotionScore> {
    const parsed = recordMotionScoreParamsSchema.parse(params);
    const row: MotionScore = {
      id: `00000000-0000-4000-8000-${String(this.nextId++).padStart(12, "0")}`,
      tenantId: parsed.tenantId,
      scoredAt: new Date(),
      scorerVersion: parsed.scorerVersion,
      scores: parsed.scores,
      inputsDigest: parsed.inputsDigest,
      rationale: parsed.rationale,
      createdAt: new Date(),
    };
    this.scoreRows.push(row);
    return row;
  }

  /** Test helper: directly add a motion_stack row. */
  seedStack(row: MotionStack): void {
    this.stackRows.push(row);
  }
}

// ---------------------------------------------------------------------------
// PostgresMotionStackRepository
// ---------------------------------------------------------------------------

export class PostgresMotionStackRepository implements MotionStackRepository {
  constructor(private readonly db: GrowthOsDb) {}

  private async withTenantCtx<T>(
    tenantId: string,
    fn: (tx: TxClient) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      await setTenantCtx(tx, tenantId);
      return fn(tx);
    });
  }

  async getLatestScore(tenantId: string): Promise<MotionScore | null> {
    const tid = tenantIdSchema.parse(tenantId);
    const rows = await this.withTenantCtx(tid, (tx) =>
      tx
        .select()
        .from(motionScores)
        .where(eq(motionScores.tenantId, tid))
        .orderBy(desc(motionScores.scoredAt))
        .limit(1),
    );
    return rows[0] ?? null;
  }

  async getLatestStack(tenantId: string): Promise<MotionStack | null> {
    const tid = tenantIdSchema.parse(tenantId);
    const rows = await this.withTenantCtx(tid, (tx) =>
      tx
        .select()
        .from(motionStack)
        .where(eq(motionStack.tenantId, tid))
        .orderBy(desc(motionStack.createdAt))
        .limit(1),
    );
    return rows[0] ?? null;
  }

  async listRecentScores(
    tenantId: string,
    limit: number,
  ): Promise<MotionScore[]> {
    const tid = tenantIdSchema.parse(tenantId);
    return this.withTenantCtx(tid, (tx) =>
      tx
        .select()
        .from(motionScores)
        .where(eq(motionScores.tenantId, tid))
        .orderBy(desc(motionScores.scoredAt))
        .limit(limit),
    );
  }

  async getOverview(
    tenantId: string,
    historyLimit = 7,
  ): Promise<MotionOverview> {
    const [latestScore, latestStack, recentScores] = await Promise.all([
      this.getLatestScore(tenantId),
      this.getLatestStack(tenantId),
      this.listRecentScores(tenantId, historyLimit),
    ]);
    return { latestScore, latestStack, recentScores };
  }

  async recordScore(params: RecordMotionScoreParams): Promise<MotionScore> {
    const parsed = recordMotionScoreParamsSchema.parse(params);

    let result: MotionScore | undefined;
    await this.withTenantCtx(parsed.tenantId, async (tx) => {
      [result] = await tx
        .insert(motionScores)
        .values({
          tenantId: parsed.tenantId,
          scorerVersion: parsed.scorerVersion,
          scores: parsed.scores,
          inputsDigest: parsed.inputsDigest,
          rationale: parsed.rationale,
        })
        .returning();
    });
    if (!result) throw new Error("Failed to insert motion_scores row");
    return result;
  }
}
