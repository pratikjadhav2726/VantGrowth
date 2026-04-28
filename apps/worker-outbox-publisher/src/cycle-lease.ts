import type { GrowthOsDb } from "@growthos/db";
import { sql } from "drizzle-orm";
import { z } from "zod";

const leaseConfigSchema = z.object({
  advisoryLockKey: z.number().int().positive().default(1_104_021),
});

export type CycleLeaseConfig = z.infer<typeof leaseConfigSchema>;

export const cycleLeaseConfigFromEnv = (
  env: Record<string, string | undefined> = process.env,
): CycleLeaseConfig =>
  leaseConfigSchema.parse({
    advisoryLockKey: Number(env.OUTBOX_LEASE_ADVISORY_LOCK_KEY ?? "1104021"),
  });

export interface CycleLeaseGuard {
  runWithLease<T>(operation: () => Promise<T>): Promise<T | null>;
}

type LockResult = { acquired: boolean };

export class PostgresCycleLeaseGuard implements CycleLeaseGuard {
  constructor(
    private readonly db: GrowthOsDb,
    private readonly config: CycleLeaseConfig,
  ) {}

  async runWithLease<T>(operation: () => Promise<T>): Promise<T | null> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.execute<LockResult>(
        sql`SELECT pg_try_advisory_xact_lock(${this.config.advisoryLockKey}) AS acquired`,
      );

      // Drizzle execute returns { rows: [...] }
      const acquired = (rows as unknown as { rows: LockResult[] }).rows[0]
        ?.acquired;
      if (!acquired) return null;

      return operation();
    });
  }
}
