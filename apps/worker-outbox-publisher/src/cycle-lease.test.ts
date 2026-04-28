import { describe, expect, it } from "vitest";
import {
  PostgresCycleLeaseGuard,
  cycleLeaseConfigFromEnv,
} from "./cycle-lease.js";

class FakeClient {
  calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  constructor(private readonly acquired: boolean) {}

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }> {
    this.calls.push(values ? { text, values } : { text });
    if (text.includes("pg_try_advisory_xact_lock")) {
      return { rows: [{ acquired: this.acquired } as unknown as T] };
    }
    return { rows: [] as T[] };
  }

  release() {}
}

describe("PostgresCycleLeaseGuard", () => {
  it("executes operation when advisory lease is acquired", async () => {
    const client = new FakeClient(true);
    const guard = new PostgresCycleLeaseGuard(
      {
        connect: async () => client,
      },
      { advisoryLockKey: 42 },
    );

    const result = await guard.runWithLease(async () => "ok");

    expect(result).toBe("ok");
    expect(client.calls[0]?.text).toBe("BEGIN");
    expect(client.calls[1]?.text).toContain("pg_try_advisory_xact_lock");
    expect(client.calls.at(-1)?.text).toBe("COMMIT");
  });

  it("skips operation when lease is not acquired", async () => {
    const client = new FakeClient(false);
    const guard = new PostgresCycleLeaseGuard(
      {
        connect: async () => client,
      },
      { advisoryLockKey: 42 },
    );

    const result = await guard.runWithLease(async () => "unexpected");

    expect(result).toBeNull();
    expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
  });
});

describe("cycleLeaseConfigFromEnv", () => {
  it("parses lease key from environment", () => {
    const config = cycleLeaseConfigFromEnv({
      OUTBOX_LEASE_ADVISORY_LOCK_KEY: "123456",
    });
    expect(config.advisoryLockKey).toBe(123456);
  });
});
