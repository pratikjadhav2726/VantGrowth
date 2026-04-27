import { describe, expect, it } from "vitest";
import {
  type PgClient,
  type PgPool,
  PostgresOutboxRepository,
} from "./postgres-outbox-repository.js";

const tenantId = "00000000-0000-4000-8000-000000000001";

class FakePgClient implements PgClient {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = [];

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }> {
    this.calls.push(values ? { text, values } : { text });

    if (text.includes("RETURNING id")) {
      return {
        rows: [
          {
            id: "1",
            tenant_id: tenantId,
            event_type: "signal.routed.v1",
            idempotency_key: "sig-1",
            payload: { signal_id: "sig-1" },
            created_at: new Date("2026-04-27T00:00:00.000Z"),
            consumed_at: null,
          } as unknown as T,
        ],
      };
    }

    return { rows: [] };
  }
}

describe("PostgresOutboxRepository", () => {
  it("sets tenant context before writing outbox rows", async () => {
    const client = new FakePgClient();
    const pool: PgPool = {
      connect: async () => client,
    };
    const repository = new PostgresOutboxRepository(pool);

    const event = await repository.enqueue({
      tenantId,
      eventType: "signal.routed.v1",
      idempotencyKey: "sig-1",
      payload: { signal_id: "sig-1" },
    });

    expect(event.id).toBe("1");
    expect(client.calls[0]?.text).toBe("BEGIN");
    expect(client.calls[1]?.text).toContain("set_config('app.tenant_id'");
    expect(client.calls[2]?.text).toContain(
      "ON CONFLICT (tenant_id, event_type, idempotency_key) DO NOTHING",
    );
    expect(client.calls.at(-1)?.text).toBe("COMMIT");
  });
});
