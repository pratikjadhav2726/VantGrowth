/**
 * PlaybookVersionsRepository — Phase 1 / S4
 *
 * Manages versioned playbooks used by the Critique/Learning loop.  Each
 * tenant maintains an independent version sequence per playbook_type.  Only
 * one version can be "active" (retired_at IS NULL) per (tenant, type) at a
 * time — retire the current version before creating a replacement (or leave
 * both active if you want a smooth cut-over).
 *
 * Design decisions:
 *   - Version numbers are auto-incremented by the repository (not the caller)
 *     to prevent races in concurrent create calls.
 *   - The Postgres implementation executes every write inside a transaction
 *     with set_config() to satisfy the RLS FORCE policy.
 *   - InMemoryPlaybookVersionsRepository mirrors the same invariants for
 *     test isolation.
 */

import { and, desc, eq, isNull, max, sql } from "drizzle-orm";
import { z } from "zod";
import { tenantIdSchema } from "./contracts.js";
import type { GrowthOsDb } from "./db.js";
import {
  type PlaybookTypeValue,
  playbookTypeValues,
  playbookVersions,
} from "./schema.js";
import type { TenantContext } from "./tenant-context.js";

// ─── Domain types ────────────────────────────────────────────────────────────

export const playbookVersionRecordSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  playbookType: z.enum(playbookTypeValues),
  version: z.number().int().positive(),
  name: z.string().min(1),
  description: z.string().nullable(),
  content: z.record(z.unknown()),
  effectiveAt: z.date(),
  retiredAt: z.date().nullable(),
  createdBy: z.string().min(1),
  createdAt: z.date(),
});

export type PlaybookVersionRecord = z.infer<typeof playbookVersionRecordSchema>;

export interface CreatePlaybookVersionParams {
  playbookType: PlaybookTypeValue;
  name: string;
  description?: string;
  content: Record<string, unknown>;
  createdBy: string;
  effectiveAt?: Date;
}

// ─── Repository interface ────────────────────────────────────────────────────

export interface PlaybookVersionsRepository {
  /**
   * Returns the highest-versioned non-retired playbook of the given type,
   * or null if none exists.
   */
  getActive(
    tenantId: string,
    playbookType: PlaybookTypeValue,
  ): Promise<PlaybookVersionRecord | null>;

  /**
   * Lists all playbooks of the given type, newest version first.
   * Includes retired versions for audit purposes.
   */
  listAll(
    tenantId: string,
    playbookType: PlaybookTypeValue,
  ): Promise<PlaybookVersionRecord[]>;

  /**
   * Creates a new playbook version, auto-computing the next version number
   * as MAX(existing_versions) + 1 for this (tenant, type) pair.
   */
  create(
    tenantId: string,
    params: CreatePlaybookVersionParams,
  ): Promise<PlaybookVersionRecord>;

  /**
   * Soft-retires a playbook version (sets retired_at = NOW()).
   * Idempotent: a no-op if the record is already retired.
   */
  retire(tenantId: string, id: string): Promise<void>;
}

// ─── In-memory implementation ────────────────────────────────────────────────

export class InMemoryPlaybookVersionsRepository
  implements PlaybookVersionsRepository
{
  private readonly records = new Map<string, PlaybookVersionRecord>();
  // Tracks the highest version seen per (tenantId, playbookType)
  private readonly versionCounters = new Map<string, number>();

  private typeKey(tenantId: string, playbookType: PlaybookTypeValue): string {
    return `${tenantId}:${playbookType}`;
  }

  async getActive(
    tenantId: string,
    playbookType: PlaybookTypeValue,
  ): Promise<PlaybookVersionRecord | null> {
    const candidates = Array.from(this.records.values())
      .filter(
        (r) =>
          r.tenantId === tenantId &&
          r.playbookType === playbookType &&
          r.retiredAt === null,
      )
      .sort((a, b) => b.version - a.version);
    return candidates[0] ?? null;
  }

  async listAll(
    tenantId: string,
    playbookType: PlaybookTypeValue,
  ): Promise<PlaybookVersionRecord[]> {
    return Array.from(this.records.values())
      .filter((r) => r.tenantId === tenantId && r.playbookType === playbookType)
      .sort((a, b) => b.version - a.version);
  }

  async create(
    tenantId: string,
    params: CreatePlaybookVersionParams,
  ): Promise<PlaybookVersionRecord> {
    tenantIdSchema.parse(tenantId);
    const key = this.typeKey(tenantId, params.playbookType);
    const nextVersion = (this.versionCounters.get(key) ?? 0) + 1;
    this.versionCounters.set(key, nextVersion);

    const record = playbookVersionRecordSchema.parse({
      id: crypto.randomUUID(),
      tenantId,
      playbookType: params.playbookType,
      version: nextVersion,
      name: params.name,
      description: params.description ?? null,
      content: params.content,
      effectiveAt: params.effectiveAt ?? new Date(),
      retiredAt: null,
      createdBy: params.createdBy,
      createdAt: new Date(),
    });

    this.records.set(record.id, record);
    return record;
  }

  async retire(tenantId: string, id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record) return; // idempotent
    if (record.tenantId !== tenantId) return; // scope check
    if (record.retiredAt !== null) return; // already retired
    this.records.set(id, { ...record, retiredAt: new Date() });
  }
}

// ─── Postgres implementation ─────────────────────────────────────────────────

const mapRow = (
  row: typeof playbookVersions.$inferSelect,
): PlaybookVersionRecord =>
  playbookVersionRecordSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    playbookType: row.playbookType,
    // Drizzle maps numeric columns to string; coerce to integer
    version: Number(row.version),
    name: row.name,
    description: row.description ?? null,
    content: row.content,
    effectiveAt: row.effectiveAt,
    retiredAt: row.retiredAt ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  });

const setTenantContext = (
  tx: Parameters<Parameters<GrowthOsDb["transaction"]>[0]>[0],
  tenantId: string,
) =>
  tx.execute(
    sql`SELECT set_config('app.tenant_id', ${tenantId}, true), set_config('app.actor_kind', 'system', true)`,
  );

export class PostgresPlaybookVersionsRepository
  implements PlaybookVersionsRepository
{
  constructor(
    private readonly db: GrowthOsDb,
    private readonly context: Partial<TenantContext> = {},
  ) {}

  async getActive(
    tenantId: string,
    playbookType: PlaybookTypeValue,
  ): Promise<PlaybookVersionRecord | null> {
    tenantIdSchema.parse(tenantId);
    let result: PlaybookVersionRecord | null = null;

    await this.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId);
      const rows = await tx
        .select()
        .from(playbookVersions)
        .where(
          and(
            eq(playbookVersions.tenantId, tenantId),
            eq(playbookVersions.playbookType, playbookType),
            isNull(playbookVersions.retiredAt),
          ),
        )
        .orderBy(desc(playbookVersions.version))
        .limit(1);
      result = rows[0] ? mapRow(rows[0]) : null;
    });

    return result;
  }

  async listAll(
    tenantId: string,
    playbookType: PlaybookTypeValue,
  ): Promise<PlaybookVersionRecord[]> {
    tenantIdSchema.parse(tenantId);
    let results: PlaybookVersionRecord[] = [];

    await this.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId);
      const rows = await tx
        .select()
        .from(playbookVersions)
        .where(
          and(
            eq(playbookVersions.tenantId, tenantId),
            eq(playbookVersions.playbookType, playbookType),
          ),
        )
        .orderBy(desc(playbookVersions.version));
      results = rows.map(mapRow);
    });

    return results;
  }

  async create(
    tenantId: string,
    params: CreatePlaybookVersionParams,
  ): Promise<PlaybookVersionRecord> {
    tenantIdSchema.parse(tenantId);
    let record: PlaybookVersionRecord | null = null;

    await this.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId);

      // Compute next version within the transaction to serialise concurrent creates.
      const maxResult = await tx
        .select({ maxVersion: max(playbookVersions.version) })
        .from(playbookVersions)
        .where(
          and(
            eq(playbookVersions.tenantId, tenantId),
            eq(playbookVersions.playbookType, params.playbookType),
          ),
        );
      const nextVersion = String(Number(maxResult[0]?.maxVersion ?? "0") + 1);

      const rows = await tx
        .insert(playbookVersions)
        .values({
          tenantId,
          playbookType: params.playbookType,
          version: nextVersion,
          name: params.name,
          description: params.description ?? null,
          content: params.content,
          effectiveAt: params.effectiveAt ?? new Date(),
          retiredAt: null,
          createdBy: params.createdBy,
        })
        .returning();

      const row = rows[0];
      if (!row) throw new Error("playbook_versions insert returned no row");
      record = mapRow(row);
    });

    if (!record) throw new Error("Failed to create playbook version");
    return record;
  }

  async retire(tenantId: string, id: string): Promise<void> {
    tenantIdSchema.parse(tenantId);
    await this.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId);
      await tx
        .update(playbookVersions)
        .set({ retiredAt: new Date() })
        .where(
          and(
            eq(playbookVersions.tenantId, tenantId),
            eq(playbookVersions.id, id),
            isNull(playbookVersions.retiredAt),
          ),
        );
    });
  }
}
