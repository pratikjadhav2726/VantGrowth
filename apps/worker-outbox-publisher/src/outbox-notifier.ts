import pg from "pg";
import type { Notification } from "pg";

const { Pool } = pg;

export const OUTBOX_NOTIFY_CHANNEL = "growthos_outbox_events";

export interface OutboxNotifier {
  start(onWakeup: (tenantId: string | null) => void): Promise<void>;
  close(): Promise<void>;
}

export const parseOutboxNotificationTenantId = (
  payload: string | null,
): string | null => {
  if (!payload) return null;

  try {
    const parsed = JSON.parse(payload) as { tenantId?: unknown };
    return typeof parsed.tenantId === "string" ? parsed.tenantId : null;
  } catch {
    return null;
  }
};

export class PostgresOutboxNotifier implements OutboxNotifier {
  private readonly pool: pg.Pool;
  private client: pg.PoolClient | null = null;

  constructor(
    private readonly connectionString: string,
    private readonly channel = OUTBOX_NOTIFY_CHANNEL,
  ) {
    this.pool = new Pool({ connectionString, max: 1, idleTimeoutMillis: 0 });
  }

  static fromEnv(
    env: Record<string, string | undefined> = process.env,
  ): PostgresOutboxNotifier | null {
    const connectionString = env.DATABASE_URL;
    if (!connectionString) return null;
    return new PostgresOutboxNotifier(connectionString);
  }

  async start(onWakeup: (tenantId: string | null) => void): Promise<void> {
    if (this.client) return;

    const client = await this.pool.connect();
    await client.query(`LISTEN ${this.channel}`);
    client.on("notification", (message: Notification) => {
      if (message.channel !== this.channel) return;
      onWakeup(parseOutboxNotificationTenantId(message.payload ?? null));
    });
    this.client = client;
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.query(`UNLISTEN ${this.channel}`);
      this.client.release();
      this.client = null;
    }

    await this.pool.end();
  }
}
