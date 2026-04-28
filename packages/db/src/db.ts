import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

const { Pool } = pg;

export type GrowthOsDb = NodePgDatabase<typeof schema>;

export interface DbConfig {
  connectionString: string;
  poolMax?: number;
  idleTimeoutMs?: number;
}

export const dbConfigFromEnv = (
  env: Record<string, string | undefined> = process.env,
): DbConfig | null => {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) return null;
  return {
    connectionString,
    poolMax: env.DATABASE_POOL_MAX ? Number(env.DATABASE_POOL_MAX) : 10,
    idleTimeoutMs: env.DATABASE_IDLE_TIMEOUT_MS
      ? Number(env.DATABASE_IDLE_TIMEOUT_MS)
      : 30_000,
  };
};

export const createDb = (config: DbConfig): GrowthOsDb => {
  const pool = new Pool({
    connectionString: config.connectionString,
    max: config.poolMax ?? 10,
    idleTimeoutMillis: config.idleTimeoutMs ?? 30_000,
  });
  return drizzle(pool, { schema });
};

export const createDbFromEnv = (
  env: Record<string, string | undefined> = process.env,
): GrowthOsDb => {
  const config = dbConfigFromEnv(env);
  if (!config)
    throw new Error(
      "DATABASE_URL is required to create the Drizzle DB client.",
    );
  return createDb(config);
};
