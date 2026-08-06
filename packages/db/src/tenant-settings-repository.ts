/**
 * TenantSettingsRepository — Phase 1 / S6
 *
 * Persists founder console settings as one JSON document per tenant
 * (`growthos.tenant_settings`). Shallow-merge PATCH semantics: unknown keys are
 * preserved; PATCH body keys replace or add top-level fields.
 */

import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { tenantIdSchema } from "./contracts.js";
import type { GrowthOsDb } from "./db.js";
import { type TenantSettingsRow, tenantSettings } from "./schema.js";

type TxClient = Parameters<Parameters<GrowthOsDb["transaction"]>[0]>[0];

const setTenantCtx = (tx: TxClient, tenantId: string) =>
  tx.execute(
    sql`SELECT set_config('app.tenant_id', ${tenantId}, true),
             set_config('app.actor_id', '', true),
             set_config('app.actor_kind', 'system', true)`,
  );

export const tenantSettingsPatchSchema = z.record(z.unknown());

export type TenantSettingsPayload = Record<string, unknown>;

function shallowMerge(
  base: TenantSettingsPayload,
  patch: TenantSettingsPayload,
): TenantSettingsPayload {
  const next = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) next[k] = v;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface TenantSettingsRepository {
  /** Returns merged settings object (empty object if no row exists). */
  get(tenantId: string): Promise<TenantSettingsPayload>;

  /** Shallow-merges `patch` into existing settings and upserts the row. */
  patch(
    tenantId: string,
    patch: TenantSettingsPayload,
  ): Promise<TenantSettingsPayload>;
}

// ---------------------------------------------------------------------------
// InMemoryTenantSettingsRepository
// ---------------------------------------------------------------------------

export class InMemoryTenantSettingsRepository
  implements TenantSettingsRepository
{
  private readonly rows = new Map<string, TenantSettingsPayload>();

  async get(tenantId: string): Promise<TenantSettingsPayload> {
    const tid = tenantIdSchema.parse(tenantId);
    const raw = this.rows.get(tid);
    return raw ? { ...raw } : {};
  }

  async patch(
    tenantId: string,
    patch: TenantSettingsPayload,
  ): Promise<TenantSettingsPayload> {
    const tid = tenantIdSchema.parse(tenantId);
    const parsed = tenantSettingsPatchSchema.parse(patch);
    const merged = shallowMerge(await this.get(tid), parsed);
    this.rows.set(tid, merged);
    return { ...merged };
  }

  /** Test helper */
  seed(tenantId: string, settings: TenantSettingsPayload): void {
    this.rows.set(tenantIdSchema.parse(tenantId), { ...settings });
  }
}

// ---------------------------------------------------------------------------
// PostgresTenantSettingsRepository
// ---------------------------------------------------------------------------

export class PostgresTenantSettingsRepository
  implements TenantSettingsRepository
{
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

  async get(tenantId: string): Promise<TenantSettingsPayload> {
    const tid = tenantIdSchema.parse(tenantId);
    const rows = await this.withTenantCtx(tid, (tx) =>
      tx
        .select()
        .from(tenantSettings)
        .where(eq(tenantSettings.tenantId, tid))
        .limit(1),
    );
    const row = rows[0];
    if (!row) return {};
    return { ...(row.settings as TenantSettingsPayload) };
  }

  async patch(
    tenantId: string,
    patch: TenantSettingsPayload,
  ): Promise<TenantSettingsPayload> {
    const tid = tenantIdSchema.parse(tenantId);
    const parsed = tenantSettingsPatchSchema.parse(patch);

    let row: TenantSettingsRow | undefined;
    await this.withTenantCtx(tid, async (tx) => {
      const [existing] = await tx
        .select()
        .from(tenantSettings)
        .where(eq(tenantSettings.tenantId, tid))
        .limit(1);

      const base = (existing?.settings as TenantSettingsPayload) ?? {};
      const merged = shallowMerge(base, parsed);

      if (existing) {
        [row] = await tx
          .update(tenantSettings)
          .set({
            settings: merged as Record<string, unknown>,
            updatedAt: new Date(),
          })
          .where(eq(tenantSettings.tenantId, tid))
          .returning();
      } else {
        [row] = await tx
          .insert(tenantSettings)
          .values({
            tenantId: tid,
            settings: merged as Record<string, unknown>,
          })
          .returning();
      }
    });

    if (!row) throw new Error("tenant_settings upsert failed");
    return { ...(row.settings as TenantSettingsPayload) };
  }
}
