import pg from "pg";
import {
  enqueueOutboxEventSchema,
  storedOutboxEventSchema,
  tenantIdSchema,
  type EnqueueOutboxEvent,
  type StoredOutboxEvent
} from "./contracts.js";
import type { OutboxRepository } from "./outbox-repository.js";
import { createTenantSettingsSql } from "./tenant-context.js";

const { Pool } = pg;

export interface PgClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<{ rows: T[] }>;
  release?(): void;
}

export interface PgPool {
  connect(): Promise<PgClient>;
}

export interface PostgresOutboxRepositoryOptions {
  actorId?: string;
  actorKind?: "user" | "agent" | "system";
}

interface OutboxRow extends Record<string, unknown> {
  id: string | number | bigint;
  tenant_id: string;
  event_type: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  created_at: Date | string;
  consumed_at: Date | string | null;
}

export const createPgPoolFromEnv = (env: Record<string, string | undefined> = process.env): PgPool => {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required to create a Postgres pool.");

  return new Pool({
    connectionString,
    max: Number(env.DATABASE_POOL_MAX ?? 10),
    idleTimeoutMillis: Number(env.DATABASE_IDLE_TIMEOUT_MS ?? 30_000)
  });
};

const mapOutboxRow = (row: OutboxRow): StoredOutboxEvent =>
  storedOutboxEventSchema.parse({
    id: String(row.id),
    tenantId: row.tenant_id,
    eventType: row.event_type,
    idempotencyKey: row.idempotency_key,
    payload: row.payload,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    consumedAt: row.consumed_at === null ? null : row.consumed_at instanceof Date ? row.consumed_at : new Date(row.consumed_at)
  });

export class PostgresOutboxRepository implements OutboxRepository {
  constructor(
    private readonly pool: PgPool,
    private readonly options: PostgresOutboxRepositoryOptions = {}
  ) {}

  async enqueue(command: EnqueueOutboxEvent): Promise<StoredOutboxEvent> {
    const parsed = enqueueOutboxEventSchema.parse(command);

    return this.withTenantClient(parsed.tenantId, async (client) => {
      const result = await client.query<OutboxRow>(
        `
        WITH inserted AS (
          INSERT INTO growthos.event_outbox (tenant_id, event_type, idempotency_key, payload)
          VALUES ($1, $2, $3, $4::jsonb)
          ON CONFLICT (tenant_id, event_type, idempotency_key) DO NOTHING
          RETURNING id, tenant_id, event_type, idempotency_key, payload, created_at, consumed_at
        )
        SELECT id, tenant_id, event_type, idempotency_key, payload, created_at, consumed_at
        FROM inserted
        UNION ALL
        SELECT id, tenant_id, event_type, idempotency_key, payload, created_at, consumed_at
        FROM growthos.event_outbox
        WHERE tenant_id = $1
          AND event_type = $2
          AND idempotency_key = $3
        LIMIT 1
        `,
        [parsed.tenantId, parsed.eventType, parsed.idempotencyKey, JSON.stringify(parsed.payload)]
      );

      const row = result.rows[0];
      if (!row) throw new Error("Failed to enqueue or load outbox event.");
      return mapOutboxRow(row);
    });
  }

  async markConsumed(tenantId: string, eventId: string, consumedAt = new Date()): Promise<StoredOutboxEvent> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);

    return this.withTenantClient(parsedTenantId, async (client) => {
      const result = await client.query<OutboxRow>(
        `
        UPDATE growthos.event_outbox
        SET consumed_at = $3
        WHERE tenant_id = $1
          AND id = $2
        RETURNING id, tenant_id, event_type, idempotency_key, payload, created_at, consumed_at
        `,
        [parsedTenantId, eventId, consumedAt]
      );

      const row = result.rows[0];
      if (!row) throw new Error(`Outbox event not found for tenant: ${eventId}`);
      return mapOutboxRow(row);
    });
  }

  async listUnconsumed(tenantId: string, limit: number): Promise<StoredOutboxEvent[]> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);

    return this.withTenantClient(parsedTenantId, async (client) => {
      const result = await client.query<OutboxRow>(
        `
        SELECT id, tenant_id, event_type, idempotency_key, payload, created_at, consumed_at
        FROM growthos.event_outbox
        WHERE tenant_id = $1
          AND consumed_at IS NULL
        ORDER BY id ASC
        LIMIT $2
        `,
        [parsedTenantId, limit]
      );

      return result.rows.map(mapOutboxRow);
    });
  }

  private async withTenantClient<T>(tenantId: string, operation: (client: PgClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const tenantSettings = createTenantSettingsSql({
        tenantId,
        ...(this.options.actorId ? { actorId: this.options.actorId } : {}),
        actorKind: this.options.actorKind ?? "system"
      });
      await client.query(tenantSettings.sql, tenantSettings.params);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release?.();
    }
  }
}
