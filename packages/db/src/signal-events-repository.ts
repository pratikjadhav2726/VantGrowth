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

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
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
   * Marks the given signal IDs as processed (sets processed_at = NOW()).
   * Idempotent: already-processed records are not updated again.
   */
  markProcessed(tenantId: string, ids: bigint[]): Promise<void>;
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
        this.records[i] = { ...r, processedAt: now };
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

  async markProcessed(tenantId: string, ids: bigint[]): Promise<void> {
    if (ids.length === 0) return;
    tenantIdSchema.parse(tenantId);

    await this.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId);
      await tx
        .update(signalEvents)
        .set({ processedAt: new Date() })
        .where(
          and(
            eq(signalEvents.tenantId, tenantId),
            inArray(signalEvents.id, ids),
            isNull(signalEvents.processedAt),
          ),
        );
    });
  }
}
