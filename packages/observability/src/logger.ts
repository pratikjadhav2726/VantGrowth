/**
 * Structured logger factory built on pino.
 *
 * Every log line carries `service` in the base object.  Call-sites should
 * pass a `LogContext` with `tenantId`, `runId`, `agentId`, and `traceId` /
 * `spanId` so lines can be correlated with OTel traces in SigNoz.
 *
 * Usage:
 *   const log = createLogger("growthos.api");
 *   log.info({ tenantId, runId }, "outbox enqueued");
 */
import pino from "pino";

export type { Logger } from "pino";

export interface LogContext {
  /** GrowthOS tenant UUID */
  tenantId?: string;
  /** Restate / workflow run ID */
  runId?: string;
  /** Paperclip agent ID */
  agentId?: string;
  /** OTel trace ID (hex) — allows log↔trace correlation in SigNoz */
  traceId?: string;
  /** OTel span ID (hex) */
  spanId?: string;
}

export interface LoggerOptions {
  /** Override log level; defaults to `LOG_LEVEL` env var or `"info"`. */
  level?: string;
  /** Pretty-print in development (never enabled when NODE_ENV=production). */
  pretty?: boolean;
}

export const createLogger = (
  service: string,
  opts: LoggerOptions = {},
): pino.Logger => {
  const level = opts.level ?? process.env.LOG_LEVEL ?? "info";
  const pretty =
    (opts.pretty ?? process.env.NODE_ENV !== "production") &&
    process.env.NODE_ENV !== "test";

  return pino({
    base: { service },
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    ...(pretty
      ? {
          transport: {
            target: "pino-pretty",
            options: { colorize: true, ignore: "pid,hostname" },
          },
        }
      : {}),
  });
};
