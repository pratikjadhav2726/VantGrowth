import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { EnqueueOutboxEvent, StoredOutboxEvent } from "./contracts.js";
import {
  enqueueOutboxEventSchema,
  storedOutboxEventSchema,
  tenantIdSchema,
} from "./contracts.js";
import type { GrowthOsDb } from "./db.js";
import type { OutboxRepository } from "./outbox-repository.js";
import { eventOutbox } from "./schema.js";
import type { TenantContext } from "./tenant-context.js";

export type { GrowthOsDb };

// ─── helpers ─────────────────────────────────────────────────────────────────

const mapRow = (row: typeof eventOutbox.$inferSelect): StoredOutboxEvent =>
  storedOutboxEventSchema.parse({
    id: String(row.id),
    tenantId: row.tenantId,
    eventType: row.eventType,
    idempotencyKey: row.idempotencyKey,
    payload: row.payload,
    createdAt: row.createdAt,
    consumedAt: row.consumedAt ?? null,
  });

const setTenantContext = (
  tx: Parameters<Parameters<GrowthOsDb["transaction"]>[0]>[0],
  context: TenantContext,
) =>
  tx.execute(
    sql`SELECT
      set_config('app.tenant_id',  ${context.tenantId},           true),
      set_config('app.actor_id',   ${context.actorId ?? ""},      true),
      set_config('app.actor_kind', ${context.actorKind ?? "system"}, true)`,
  );

// ─── PostgresOutboxRepository ─────────────────────────────────────────────────

export class PostgresOutboxRepository implements OutboxRepository {
  constructor(
    private readonly db: GrowthOsDb,
    private readonly context: Partial<TenantContext> = {},
  ) {}

  async enqueue(command: EnqueueOutboxEvent): Promise<StoredOutboxEvent> {
    const parsed = enqueueOutboxEventSchema.parse(command);
    const tenantContext: TenantContext = {
      tenantId: parsed.tenantId,
      ...(this.context.actorId ? { actorId: this.context.actorId } : {}),
      actorKind: this.context.actorKind ?? "system",
    };

    return this.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantContext);

      // Idempotent insert: on conflict return the existing row.
      await tx
        .insert(eventOutbox)
        .values({
          tenantId: parsed.tenantId,
          eventType: parsed.eventType,
          idempotencyKey: parsed.idempotencyKey,
          payload: parsed.payload,
        })
        .onConflictDoNothing({
          target: [
            eventOutbox.tenantId,
            eventOutbox.eventType,
            eventOutbox.idempotencyKey,
          ],
        });

      const [row] = await tx
        .select()
        .from(eventOutbox)
        .where(
          and(
            eq(eventOutbox.tenantId, parsed.tenantId),
            eq(eventOutbox.eventType, parsed.eventType),
            eq(eventOutbox.idempotencyKey, parsed.idempotencyKey),
          ),
        )
        .limit(1);

      if (!row) throw new Error("Failed to enqueue or load outbox event.");

      // Notify other processes that a new event is ready to drain.
      await tx.execute(
        sql`SELECT pg_notify(
          'growthos_outbox_events',
          ${JSON.stringify({ tenantId: parsed.tenantId, eventId: String(row.id) })}
        )`,
      );

      return mapRow(row);
    });
  }

  async markConsumed(
    tenantId: string,
    eventId: string,
    consumedAt = new Date(),
  ): Promise<StoredOutboxEvent> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const tenantContext: TenantContext = {
      tenantId: parsedTenantId,
      ...(this.context.actorId ? { actorId: this.context.actorId } : {}),
      actorKind: this.context.actorKind ?? "system",
    };

    return this.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantContext);

      const [row] = await tx
        .update(eventOutbox)
        .set({ consumedAt })
        .where(
          and(
            eq(eventOutbox.tenantId, parsedTenantId),
            eq(eventOutbox.id, BigInt(eventId)),
          ),
        )
        .returning();

      if (!row)
        throw new Error(`Outbox event not found for tenant: ${eventId}`);
      return mapRow(row);
    });
  }

  async listUnconsumed(
    tenantId: string,
    limit: number,
  ): Promise<StoredOutboxEvent[]> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const tenantContext: TenantContext = {
      tenantId: parsedTenantId,
      ...(this.context.actorId ? { actorId: this.context.actorId } : {}),
      actorKind: this.context.actorKind ?? "system",
    };

    return this.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantContext);

      const rows = await tx
        .select()
        .from(eventOutbox)
        .where(
          and(
            eq(eventOutbox.tenantId, parsedTenantId),
            isNull(eventOutbox.consumedAt),
          ),
        )
        .orderBy(asc(eventOutbox.id))
        .limit(limit);

      return rows.map(mapRow);
    });
  }
}
