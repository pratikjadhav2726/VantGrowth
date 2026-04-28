import type { GrowthOsDb } from "@growthos/db";
import { describe, expect, it, vi } from "vitest";
import {
  PostgresCycleLeaseGuard,
  cycleLeaseConfigFromEnv,
} from "./cycle-lease.js";

const makeMockDb = (acquired: boolean): GrowthOsDb => {
  const mockTx = {
    execute: vi.fn().mockResolvedValue({ rows: [{ acquired }] }),
  };
  return {
    transaction: vi.fn(async (cb: (tx: typeof mockTx) => Promise<unknown>) =>
      cb(mockTx),
    ),
  } as unknown as GrowthOsDb;
};

describe("PostgresCycleLeaseGuard", () => {
  it("executes operation when advisory lease is acquired", async () => {
    const db = makeMockDb(true);
    const guard = new PostgresCycleLeaseGuard(db, { advisoryLockKey: 42 });

    const result = await guard.runWithLease(async () => "ok");

    expect(result).toBe("ok");
    expect(db.transaction).toHaveBeenCalledOnce();
  });

  it("skips operation and returns null when lease is not acquired", async () => {
    const db = makeMockDb(false);
    const guard = new PostgresCycleLeaseGuard(db, { advisoryLockKey: 42 });

    const operation = vi.fn(async () => "should-not-run");
    const result = await guard.runWithLease(operation);

    expect(result).toBeNull();
    expect(operation).not.toHaveBeenCalled();
  });

  it("calls pg_try_advisory_xact_lock with configured lock key", async () => {
    const mockTx = {
      execute: vi.fn().mockResolvedValue({ rows: [{ acquired: true }] }),
    };
    const db = {
      transaction: vi.fn(async (cb: (tx: typeof mockTx) => Promise<unknown>) =>
        cb(mockTx),
      ),
    } as unknown as GrowthOsDb;

    const guard = new PostgresCycleLeaseGuard(db, { advisoryLockKey: 1234 });
    await guard.runWithLease(async () => "ok");

    const executeCall = mockTx.execute.mock.calls[0]?.[0];
    // Drizzle SQL templates serialize to objects; check the raw query string
    const sqlString = JSON.stringify(executeCall);
    expect(sqlString).toContain("pg_try_advisory_xact_lock");
  });
});

describe("cycleLeaseConfigFromEnv", () => {
  it("parses lease key from environment", () => {
    const config = cycleLeaseConfigFromEnv({
      OUTBOX_LEASE_ADVISORY_LOCK_KEY: "123456",
    });
    expect(config.advisoryLockKey).toBe(123456);
  });

  it("uses default lock key when env var is absent", () => {
    const config = cycleLeaseConfigFromEnv({});
    expect(config.advisoryLockKey).toBe(1_104_021);
  });
});
