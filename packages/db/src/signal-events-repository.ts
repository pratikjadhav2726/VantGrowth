/**
 * SignalEventsRepository — Phase 1 / S3
 *
 * High-volume write path for incoming signals (competitive, community, ICP, etc.)
 * written by the Signal Router and read by the Intel Director.
 *
 * Idempotency model:
 *   - When externalId is provided: deduplicate by (tenant_id, source, external_id).
 *     The partial unique index `signal_events_tenant_source_external_uniq
 *     (WHERE external_id IS NOT NULL)` enforces this at the DB level.
 *   - When externalId is absent: every ingest creates a new row (no dedup).
 *
 * Processed flag: `processed_at` is NULL for unprocessed signals.  The Intel
 * Director calls `markProcessed()` after including a signal in a brief.
 */

import { and, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { tenantIdSchema } from "./contracts.js";
import type { GrowthOsDb } from "./db.js";
import {
  type SignalTypeValue,
  signalEvents,
  signalTypeValues,
} from "./schema.js";
import type { TenantContext } from "./tenant-context.js";

// ─── Domain types ────────────────────────────────────────────────────────────

export const signalEventRecordSchema = z.object({
  id: z.bigint(),
  tenantId: z.string().uuid(),
  signalType: z.enum(signalTypeValues),
  source: z.string().min(1),
  externalId: z.string().nullable(),
  payload: z.record(z.unknown()),
  processedAt: z.date().nullable(),
  processingLeaseOwner: z.string().nullable(),
  processingLeaseExpiresAt: z.date().nullable(),
  processingAttempts: z.number().int().nonnegative(),
  createdAt: z.date(),
});

export type SignalEventRecord = z.infer<typeof signalEventRecordSchema>;

export interface IngestSignalParams {
  tenantId: string;
  signalType: SignalTypeValue;
  source: string;
  externalId?: string;
  payload: Record<string, unknown>;
}

export interface IngestSignalResult {
  event: SignalEventRecord;
  /** True when a record with the same (tenant, source, externalId) already existed. */
  isDuplicate: boolean;
}

export const signalProcessingClaimSchema = z.object({
  owner: z.string().min(1).max(255),
  leaseMs: z.number().int().min(1_000).max(15 * 60_000),
});

export type SignalProcessingClaim = z.infer<
  typeof signalProcessingClaimSchema
>;

// ─── Repository interface ────────────────────────────────────────────────────

export interface SignalEventsRepository {
  /**
   * Ingests a signal, deduplicating by (tenant, source, externalId) when
   * externalId is provided.  Returns the stored record and a `isDuplicate` flag.
   */
  ingest(params: IngestSignalParams): Promise<IngestSignalResult>;

  /**
   * Returns up to `limit` unprocessed signals for the given tenant and type,
   * ordered by id (oldest first) to ensure FIFO processing.
   */
  listUnprocessed(
    tenantId: string,
    signalType: SignalTypeValue,
    limit: number,
  ): Promise<SignalEventRecord[]>;

  /**
   * Atomically reserves unprocessed rows for one router replica. Rows with an
   * expired lease are recoverable after a process crash; active leases are
   * never returned to another worker.
   */
  claimUnprocessed(
    tenantId: string,
    signalType: SignalTypeValue,
    limit: number,
    claim: SignalProcessingClaim,
  ): Promise<SignalEventRecord[]>;

  /** Counts signals created at or after `since` for tenant-level reporting. */
  countSince(tenantId: string, since: Date): Promise<number>;

  /**
   * Marks the given signal IDs as processed (sets processed_at = NOW()).
   * Idempotent: already-processed records are not updated again.
   */
  markProcessed(tenantId: string, ids: bigint[]): Promise<void>;

  /** Releases a failed claim early so bounded retry logic can recover it. */
  releaseClaims(tenantId: string, ids: bigint[], owner: string): Promise<void>;
}

// ─── In-memory implementation ────────────────────────────────────────────────

export class InMemorySignalEventsRepository implements SignalEventsRepository {
  private readonly records: SignalEventRecord[] = [];
  private sequence = BigInt(0);
  // Key: `${tenantId}:${source}:${externalId}` — only populated when externalId is set
  private readonly externalIdIndex = new Set<string>();

  private externalKey(
    tenantId: string,
    source: string,
    externalId: string,
  ): string {
    return `${tenantId}:${source}:${externalId}`;
  }

  async ingest(params: IngestSignalParams): Promise<IngestSignalResult> {
    tenantIdSchema.parse(params.tenantId);

    if (params.externalId) {
      const key = this.externalKey(
        params.tenantId,
        params.source,
        params.externalId,
      );
      if (this.externalIdIndex.has(key)) {
        const existing = this.records.find(
          (r) =>
            r.tenantId === params.tenantId &&
            r.source === params.source &&
            r.externalId === params.externalId,
        );
        if (existing) return { event: existing, isDuplicate: true };
      }
      this.externalIdIndex.add(key);
    }

    const record = signalEventRecordSchema.parse({
      id: ++this.sequence,
      tenantId: params.tenantId,
      signalType: params.signalType,
      source: params.source,
      externalId: params.externalId ?? null,
      payload: params.payload,
      processedAt: null,
      processingLeaseOwner: null,
      processingLeaseExpiresAt: null,
      processingAttempts: 0,
      createdAt: new Date(),
    });

    this.records.push(record);
    return { event: record, isDuplicate: false };
  }

  async listUnprocessed(
    tenantId: string,
    signalType: SignalTypeValue,
    limit: number,
  ): Promise<SignalEventRecord[]> {
    return this.records
      .filter(
        (r) =>
          r.tenantId === tenantId &&
          r.signalType === signalType &&
          r.processedAt === null,
      )
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, limit);
  }

  async claimUnprocessed(
    tenantId: string,
    signalType: SignalTypeValue,
    limit: number,
    claimInput: SignalProcessingClaim,
  ): Promise<SignalEventRecord[]> {
    tenantIdSchema.parse(tenantId);
    const claim = signalProcessingClaimSchema.parse(claimInput);
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + claim.leaseMs);
    const claimed = this.records
      .filter(
        (record) =>
          record.tenantId === tenantId &&
          record.signalType === signalType &&
          record.processedAt === null &&
          (record.processingLeaseExpiresAt === null ||
            record.processingLeaseExpiresAt.getTime() <= now.getTime()),
      )
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, limit);

    for (const record of claimed) {
      const index = this.records.findIndex((candidate) => candidate.id === record.id);
      if (index < 0) continue;
      const updated = signalEventRecordSchema.parse({
        ...record,
        processingLeaseOwner: claim.owner,
        processingLeaseExpiresAt: leaseExpiresAt,
        processingAttempts: record.processingAttempts + 1,
      });
      this.records[index] = updated;
    }

    return claimed.map((record) =>
      signalEventRecordSchema.parse({
        ...record,
        processingLeaseOwner: claim.owner,
        processingLeaseExpiresAt: leaseExpiresAt,
        processingAttempts: record.processingAttempts + 1,
      }),
    );
  }

  async countSince(tenantId: string, since: Date): Promise<number> {
    return this.records.filter(
      (r) =>
        r.tenantId === tenantId && r.createdAt.getTime() >= since.getTime(),
    ).length;
  }

  async markProcessed(tenantId: string, ids: bigint[]): Promise<void> {
    const idSet = new Set(ids);
    const now = new Date();
    for (let i = 0; i < this.records.length; i++) {
      const r = this.records[i];
      if (
        r &&
        r.tenantId === tenantId &&
        idSet.has(r.id) &&
        r.processedAt === null
      ) {
        this.records[i] = {
          ...r,
          processedAt: now,
          processingLeaseOwner: null,
          processingLeaseExpiresAt: null,
        };
      }
    }
  }

  async releaseClaims(
    tenantId: string,
    ids: bigint[],
    owner: string,
  ): Promise<void> {
    const idSet = new Set(ids);
    for (let index = 0; index < this.records.length; index++) {
      const record = this.records[index];
      if (
        record &&
        record.tenantId === tenantId &&
        idSet.has(record.id) &&
        record.processedAt === null &&
        record.processingLeaseOwner === owner
      ) {
        this.records[index] = {
          ...record,
          processingLeaseOwner: null,
          processingLeaseExpiresAt: null,
        };
      }
    }
  }
}

// ─── Postgres implementation ─────────────────────────────────────────────────

const mapRow = (row: typeof signalEvents.$inferSelect): SignalEventRecord =>
  signalEventRecordSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    signalType: row.signalType,
    source: row.source,
    externalId: row.externalId ?? null,
    payload: row.payload,
    processedAt: row.processedAt ?? null,
    processingLeaseOwner: row.processingLeaseOwner ?? null,
    processingLeaseExpiresAt: row.processingLeaseExpiresAt ?? null,
    processingAttempts: row.processingAttempts,
    createdAt: row.createdAt,
  });

const setTenantContext = (
  tx: Parameters<Parameters<GrowthOsDb["transaction"]>[0]>[0],
  tenantId: string,
) =>
  tx.execute(
    sql`SELECT set_config('app.tenant_id', ${tenantId}, true), set_config('app.actor_kind', 'system', true)`,
  );

export class PostgresSignalEventsRepository implements SignalEventsRepository {
  constructor(
    private readonly db: GrowthOsDb,
    private readonly context: Partial<TenantContext> = {},
  ) {}

  async ingest(params: IngestSignalParams): Promise<IngestSignalResult> {
    tenantIdSchema.parse(params.tenantId);
    let result: IngestSignalResult | null = null;

    await this.db.transaction(async (tx) => {
      await setTenantContext(tx, params.tenantId);

      const rows = await tx
        .insert(signalEvents)
        .values({
          tenantId: params.tenantId,
          signalType: params.signalType,
          source: params.source,
          externalId: params.externalId ?? null,
          payload: params.payload,
        })
        .onConflictDoNothing()
        .returning();

      if (rows[0]) {
        result = { event: mapRow(rows[0]), isDuplicate: false };
        return;
      }

      // ON CONFLICT DO NOTHING returned nothing — find the existing row.
      if (params.externalId) {
        const existing = await tx
          .select()
          .from(signalEvents)
          .where(
            and(
              eq(signalEvents.tenantId, params.tenantId),
              eq(signalEvents.source, params.source),
              eq(signalEvents.externalId, params.externalId),
            ),
          )
          .limit(1);
        if (existing[0]) {
          result = { event: mapRow(existing[0]), isDuplicate: true };
          return;
        }
      }

      throw new Error(
        "signal_events ingest: insert returned no rows unexpectedly",
      );
    });

    if (!result) throw new Error("signal_events ingest failed");
    return result;
  }

  async listUnprocessed(
    tenantId: string,
    signalType: SignalTypeValue,
    limit: number,
  ): Promise<SignalEventRecord[]> {
    tenantIdSchema.parse(tenantId);
    let results: SignalEventRecord[] = [];

    await this.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId);
      const rows = await tx
        .select()
        .from(signalEvents)
        .where(
          and(
            eq(signalEvents.tenantId, tenantId),
            eq(signalEvents.signalType, signalType),
            isNull(signalEvents.processedAt),
          ),
        )
        .orderBy(signalEvents.id)
        .limit(limit);
      results = rows.map(mapRow);
    });

    return results;
  }

  async claimUnprocessed(
    tenantId: string,
    signalType: SignalTypeValue,
    limit: number,
    claimInput: SignalProcessingClaim,
  ): Promise<SignalEventRecord[]> {
    tenantIdSchema.parse(tenantId);
    const claim = signalProcessingClaimSchema.parse(claimInput);
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + claim.leaseMs);
    let results: SignalEventRecord[] = [];

    await this.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId);
      const claimable = await tx
        .select({ id: signalEvents.id })
        .from(signalEvents)
        .where(
          and(
            eq(signalEvents.tenantId, tenantId),
            eq(signalEvents.signalType, signalType),
            isNull(signalEvents.processedAt),
            or(
              isNull(signalEvents.processingLeaseExpiresAt),
              lte(signalEvents.processingLeaseExpiresAt, now),
            ),
          ),
        )
        .orderBy(signalEvents.id)
        .limit(limit)
        .for("update", { skipLocked: true });

      if (claimable.length === 0) return;
      const claimedIds = claimable.map((row) => row.id);
      const rows = await tx
        .update(signalEvents)
        .set({
          processingLeaseOwner: claim.owner,
          processingLeaseExpiresAt: leaseExpiresAt,
          processingAttempts: sql`${signalEvents.processingAttempts} + 1`,
        })
        .where(
          and(
            eq(signalEvents.tenantId, tenantId),
            inArray(signalEvents.id, claimedIds),
            isNull(signalEvents.processedAt),
          ),
        )
        .returning();
      results = rows.map(mapRow);
    });

    return results;
  }

  async markProcessed(tenantId: string, ids: bigint[]): Promise<void> {
    if (ids.length === 0) return;
    tenantIdSchema.parse(tenantId);

    await this.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId);
      await tx
        .update(signalEvents)
        .set({
          processedAt: new Date(),
          processingLeaseOwner: null,
          processingLeaseExpiresAt: null,
        })
        .where(
          and(
            eq(signalEvents.tenantId, tenantId),
            inArray(signalEvents.id, ids),
            isNull(signalEvents.processedAt),
          ),
        );
    });
  }

  async releaseClaims(
    tenantId: string,
    ids: bigint[],
    owner: string,
  ): Promise<void> {
    if (ids.length === 0) return;
    tenantIdSchema.parse(tenantId);

    await this.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId);
      await tx
        .update(signalEvents)
        .set({
          processingLeaseOwner: null,
          processingLeaseExpiresAt: null,
        })
        .where(
          and(
            eq(signalEvents.tenantId, tenantId),
            inArray(signalEvents.id, ids),
            eq(signalEvents.processingLeaseOwner, owner),
            isNull(signalEvents.processedAt),
          ),
        );
    });
  }

  async countSince(tenantId: string, since: Date): Promise<number> {
    tenantIdSchema.parse(tenantId);
    let result = 0;

    await this.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId);
      const [row] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(signalEvents)
        .where(
          and(
            eq(signalEvents.tenantId, tenantId),
            gte(signalEvents.createdAt, since),
          ),
        );
      result = row?.count ?? 0;
    });

    return result;
  }
}
