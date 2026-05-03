import { and, eq, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { tenantIdSchema } from "./contracts.js";
import type { GrowthOsDb } from "./db.js";
import {
  workflowRunStateValues as schemaStateValues,
  workflowRuns,
} from "./schema.js";
import type { TenantContext } from "./tenant-context.js";

// ─── State machine types ────────────────────────────────────────────────────

// Re-export the state values defined in the schema so callers can import from
// either @growthos/db/workflow-run-repository or @growthos/db directly.
export const workflowRunStateValues = schemaStateValues;

export type WorkflowRunState = (typeof workflowRunStateValues)[number];

export const workflowRunStateSchema = z.enum(workflowRunStateValues);

export const workflowRunSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  workflowId: z.string().min(1),
  dedupeKey: z.string().min(1),
  state: workflowRunStateSchema,
  failureCode: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type WorkflowRun = z.infer<typeof workflowRunSchema>;

// ─── Repository interface ───────────────────────────────────────────────────

export interface WorkflowRunRepository {
  /**
   * Idempotent: inserts a run in "requested" state only if none exists for
   * (tenantId, workflowId). Returns the existing or newly created record.
   */
  upsertRequested(
    tenantId: string,
    workflowId: string,
    dedupeKey: string,
  ): Promise<WorkflowRun>;

  /**
   * Atomic compare-and-swap state transition. Updates the row only when the
   * current state matches `fromState` and is not a terminal state. Returns the
   * updated record on success or `null` if the CAS guard failed.
   */
  transitionState(
    tenantId: string,
    workflowId: string,
    fromState: WorkflowRunState,
    toState: WorkflowRunState,
    failureCode?: string,
  ): Promise<WorkflowRun | null>;

  /**
   * Loads a workflow run by (tenantId, workflowId). Returns null if not found.
   */
  getByWorkflowId(
    tenantId: string,
    workflowId: string,
  ): Promise<WorkflowRun | null>;
}

// ─── In-memory implementation (for tests and dev) ──────────────────────────

export class InMemoryWorkflowRunRepository implements WorkflowRunRepository {
  private readonly runs = new Map<string, WorkflowRun>();

  private key(tenantId: string, workflowId: string): string {
    return `${tenantId}:${workflowId}`;
  }

  async upsertRequested(
    tenantId: string,
    workflowId: string,
    dedupeKey: string,
  ): Promise<WorkflowRun> {
    const k = this.key(tenantId, workflowId);
    const existing = this.runs.get(k);
    if (existing) return existing;

    const now = new Date();
    const run = workflowRunSchema.parse({
      id: crypto.randomUUID(),
      tenantId,
      workflowId,
      dedupeKey,
      state: "requested",
      failureCode: null,
      createdAt: now,
      updatedAt: now,
    });

    this.runs.set(k, run);
    return run;
  }

  async transitionState(
    tenantId: string,
    workflowId: string,
    fromState: WorkflowRunState,
    toState: WorkflowRunState,
    failureCode?: string,
  ): Promise<WorkflowRun | null> {
    const k = this.key(tenantId, workflowId);
    const existing = this.runs.get(k);

    // Not found, CAS fromState mismatch, or current state is terminal.
    if (
      !existing ||
      existing.state !== fromState ||
      existing.state === "completed" ||
      existing.state === "failed"
    ) {
      return null;
    }

    const updated = workflowRunSchema.parse({
      ...existing,
      state: toState,
      failureCode: failureCode ?? existing.failureCode,
      updatedAt: new Date(),
    });

    this.runs.set(k, updated);
    return updated;
  }

  async getByWorkflowId(
    tenantId: string,
    workflowId: string,
  ): Promise<WorkflowRun | null> {
    return this.runs.get(this.key(tenantId, workflowId)) ?? null;
  }
}

// ─── Postgres implementation (Drizzle ORM) ────────────────────────────────

const TERMINAL_STATES: WorkflowRunState[] = ["completed", "failed"];

const mapRow = (row: typeof workflowRuns.$inferSelect): WorkflowRun =>
  workflowRunSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    workflowId: row.workflowId,
    dedupeKey: row.dedupeKey,
    state: row.state,
    failureCode: row.failureCode ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

const setTenantContext = (
  tx: Parameters<Parameters<GrowthOsDb["transaction"]>[0]>[0],
  context: TenantContext,
) =>
  tx.execute(
    sql`SELECT
      set_config('app.tenant_id',  ${context.tenantId},              true),
      set_config('app.actor_id',   ${context.actorId ?? ""},         true),
      set_config('app.actor_kind', ${context.actorKind ?? "system"}, true)`,
  );

export class PostgresWorkflowRunRepository implements WorkflowRunRepository {
  constructor(
    private readonly db: GrowthOsDb,
    private readonly context: Partial<TenantContext> = {},
  ) {}

  async upsertRequested(
    tenantId: string,
    workflowId: string,
    dedupeKey: string,
  ): Promise<WorkflowRun> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const ctx: TenantContext = {
      tenantId: parsedTenantId,
      actorKind: this.context.actorKind ?? "system",
    };

    return this.db.transaction(async (tx) => {
      await setTenantContext(tx, ctx);

      // Idempotent insert: ignore conflict on (tenant_id, workflow_id).
      await tx
        .insert(workflowRuns)
        .values({
          tenantId: parsedTenantId,
          workflowId,
          dedupeKey,
          state: "requested",
        })
        .onConflictDoNothing({
          target: [workflowRuns.tenantId, workflowRuns.workflowId],
        });

      const [row] = await tx
        .select()
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.tenantId, parsedTenantId),
            eq(workflowRuns.workflowId, workflowId),
          ),
        )
        .limit(1);

      if (!row) throw new Error("Failed to upsert workflow run.");
      return mapRow(row);
    });
  }

  async transitionState(
    tenantId: string,
    workflowId: string,
    fromState: WorkflowRunState,
    toState: WorkflowRunState,
    failureCode?: string,
  ): Promise<WorkflowRun | null> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const ctx: TenantContext = {
      tenantId: parsedTenantId,
      actorKind: this.context.actorKind ?? "system",
    };

    return this.db.transaction(async (tx) => {
      await setTenantContext(tx, ctx);

      // CAS update: only moves the row when state matches AND is non-terminal.
      const [row] = await tx
        .update(workflowRuns)
        .set({
          state: toState,
          failureCode: failureCode ?? sql`failure_code`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(workflowRuns.tenantId, parsedTenantId),
            eq(workflowRuns.workflowId, workflowId),
            eq(workflowRuns.state, fromState),
            notInArray(workflowRuns.state, TERMINAL_STATES),
          ),
        )
        .returning();

      return row ? mapRow(row) : null;
    });
  }

  async getByWorkflowId(
    tenantId: string,
    workflowId: string,
  ): Promise<WorkflowRun | null> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const ctx: TenantContext = {
      tenantId: parsedTenantId,
      actorKind: this.context.actorKind ?? "system",
    };

    return this.db.transaction(async (tx) => {
      await setTenantContext(tx, ctx);

      const [row] = await tx
        .select()
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.tenantId, parsedTenantId),
            eq(workflowRuns.workflowId, workflowId),
          ),
        )
        .limit(1);

      return row ? mapRow(row) : null;
    });
  }
}
