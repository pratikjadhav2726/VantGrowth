import type { PgPool } from "@growthos/db";
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

interface LockRow extends Record<string, unknown> {
  acquired: boolean;
}

export class PostgresCycleLeaseGuard implements CycleLeaseGuard {
  constructor(
    private readonly pool: PgPool,
    private readonly config: CycleLeaseConfig,
  ) {}

  async runWithLease<T>(operation: () => Promise<T>): Promise<T | null> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const lockResult = await client.query<LockRow>(
        "SELECT pg_try_advisory_xact_lock($1) AS acquired",
        [this.config.advisoryLockKey],
      );
      if (!lockResult.rows[0]?.acquired) {
        await client.query("ROLLBACK");
        return null;
      }

      const result = await operation();
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
