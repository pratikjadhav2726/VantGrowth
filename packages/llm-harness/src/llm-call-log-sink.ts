/**
 * LlmCallLogSink — observability pipeline for LLM call cost and latency.
 *
 * Every `OpenAiLlmCallRunner.run()` call should append a log row so the ops
 * team can:
 *   - Track per-tenant token spend and cost.
 *   - Alert on latency regressions (P95 > threshold).
 *   - Analyse cache hit rates per prompt version.
 *   - Audit which prompt versions drove which decisions.
 *
 * Architecture:
 *   LlmCallLogSink (interface)
 *     ├── NoopLlmCallLogSink     — tests + dev (no I/O)
 *     ├── ClickHouseLlmCallLogSink — production (HTTP insert to CH)
 *     └── BufferedLlmCallLogSink  — wraps any sink; batches writes
 *
 * The ClickHouse HTTP insert protocol is used directly (no heavy driver) —
 * a JSON Lines POST to `/:table?format=JSONEachRow` is idiomatic CH practice
 * and requires no extra dependencies.
 */

import type { LlmCallResult } from "./llm-call-runner.js";

// ---------------------------------------------------------------------------
// Log row type
// ---------------------------------------------------------------------------

export interface LlmCallLogRow {
  tenantId: string;
  callId?: string;
  promptId: string;
  promptVersion: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costUsd: number;
  cached: boolean;
  /** Optional: the Paperclip agentId driving the call */
  agentId?: string;
  /** Optional: the Paperclip issue/task ID associated with the call */
  issueId?: string;
  calledAt: Date;
}

/** Builds a LlmCallLogRow from an LlmCallResult and call context. */
export const buildLogRow = (
  tenantId: string,
  promptId: string,
  result: LlmCallResult,
  opts: { agentId?: string; issueId?: string } = {},
): LlmCallLogRow => ({
  tenantId,
  promptId,
  promptVersion: result.promptVersion,
  model: result.model,
  inputTokens: result.inputTokens,
  outputTokens: result.outputTokens,
  latencyMs: result.latencyMs,
  costUsd: result.costUsd,
  cached: result.cached,
  ...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
  ...(opts.issueId !== undefined ? { issueId: opts.issueId } : {}),
  calledAt: new Date(),
});

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface LlmCallLogSink {
  /**
   * Records an LLM call.  Implementations MUST NOT throw — any I/O errors
   * should be swallowed or logged internally so that a log-sink failure never
   * blocks the caller's critical path.
   */
  log(row: LlmCallLogRow): Promise<void>;
  /** Flushes any buffered rows.  No-op on non-buffered sinks. */
  flush(): Promise<void>;
}

// ---------------------------------------------------------------------------
// NoopLlmCallLogSink — zero-cost test double
// ---------------------------------------------------------------------------

export class NoopLlmCallLogSink implements LlmCallLogSink {
  async log(_row: LlmCallLogRow): Promise<void> {}
  async flush(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// ClickHouseLlmCallLogSink — HTTP insert to ClickHouse
// ---------------------------------------------------------------------------

export interface ClickHouseSinkConfig {
  /** e.g. "http://localhost:8123" */
  baseUrl: string;
  database?: string;
  /** Credentials as "user:password" or just "user" (no password) */
  credentials?: string;
  /** Abort timeout for each insert request in ms. Default: 5000 */
  timeoutMs?: number;
}

const rowToClickHouseJson = (row: LlmCallLogRow): Record<string, unknown> => ({
  tenant_id: row.tenantId,
  ...(row.callId !== undefined ? { call_id: row.callId } : {}),
  prompt_id: row.promptId,
  prompt_version: row.promptVersion,
  model: row.model,
  input_tokens: row.inputTokens,
  output_tokens: row.outputTokens,
  latency_ms: row.latencyMs,
  cost_usd: row.costUsd.toString(),
  cached: row.cached ? 1 : 0,
  ...(row.agentId !== undefined ? { agent_id: row.agentId } : {}),
  ...(row.issueId !== undefined ? { issue_id: row.issueId } : {}),
  called_at: row.calledAt.toISOString().replace("T", " ").replace("Z", ""),
});

/**
 * Writes single rows to ClickHouse using JSONEachRow HTTP insert.
 * Use BufferedLlmCallLogSink to batch multiple rows per request.
 */
export class ClickHouseLlmCallLogSink implements LlmCallLogSink {
  private readonly config: Required<ClickHouseSinkConfig>;

  constructor(config: ClickHouseSinkConfig) {
    this.config = {
      baseUrl: config.baseUrl.replace(/\/$/, ""),
      database: config.database ?? "growthos",
      credentials: config.credentials ?? "default:",
      timeoutMs: config.timeoutMs ?? 5_000,
    };
  }

  static fromEnv(
    env: Record<string, string | undefined> = process.env,
  ): ClickHouseLlmCallLogSink {
    const baseUrl = env.CLICKHOUSE_URL ?? env.CLICKHOUSE_HTTP_URL;
    if (!baseUrl) throw new Error("CLICKHOUSE_URL env var is required");
    const cfg: ClickHouseSinkConfig = {
      baseUrl,
      database: env.CLICKHOUSE_DB ?? "growthos",
    };
    if (env.CLICKHOUSE_CREDENTIALS !== undefined) {
      cfg.credentials = env.CLICKHOUSE_CREDENTIALS;
    }
    return new ClickHouseLlmCallLogSink(cfg);
  }

  async log(row: LlmCallLogRow): Promise<void> {
    await this.insertRows([row]);
  }

  async flush(): Promise<void> {}

  async insertRows(rows: LlmCallLogRow[]): Promise<void> {
    if (rows.length === 0) return;
    const body = rows
      .map((r) => JSON.stringify(rowToClickHouseJson(r)))
      .join("\n");
    const url = `${this.config.baseUrl}/?query=INSERT+INTO+${this.config.database}.llm_call_logs+FORMAT+JSONEachRow`;

    const headers: Record<string, string> = { "Content-Type": "text/plain" };
    if (this.config.credentials) {
      const [user, ...rest] = this.config.credentials.split(":");
      const password = rest.join(":");
      headers.Authorization = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "<no body>");
        // Swallow — log failure must never block the caller's critical path.
        console.error(
          `[llm-call-log-sink] ClickHouse insert failed (${res.status}): ${text.slice(0, 200)}`,
        );
      }
    } catch (err) {
      // Network / timeout error — swallowed intentionally.
      console.error(
        `[llm-call-log-sink] ClickHouse insert error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ---------------------------------------------------------------------------
// BufferedLlmCallLogSink — batches rows, flushed on interval or max size
// ---------------------------------------------------------------------------

export interface BufferConfig {
  /** Wrapped sink that receives batched rows on flush. */
  sink: LlmCallLogSink & {
    insertRows?: (rows: LlmCallLogRow[]) => Promise<void>;
  };
  /** Max rows before an automatic flush. Default: 100 */
  maxBatchSize?: number;
  /** Auto-flush interval in ms. Default: 10_000 (10s) */
  flushIntervalMs?: number;
}

/**
 * Wraps any LlmCallLogSink with an in-memory buffer.
 *
 * Rows are accumulated in memory and flushed either:
 *   (a) when `maxBatchSize` is reached, or
 *   (b) on the periodic `flushIntervalMs` timer, or
 *   (c) when `flush()` is called explicitly (e.g. on process shutdown).
 *
 * If the wrapped sink exposes an `insertRows()` batch method (as
 * ClickHouseLlmCallLogSink does), it is preferred over N individual `log()`
 * calls to minimise HTTP round-trips.
 */
export class BufferedLlmCallLogSink implements LlmCallLogSink {
  private readonly buffer: LlmCallLogRow[] = [];
  private readonly maxBatchSize: number;
  private readonly timer: ReturnType<typeof setInterval> | null = null;
  private readonly inner: BufferConfig["sink"];

  constructor(config: BufferConfig) {
    this.inner = config.sink;
    this.maxBatchSize = config.maxBatchSize ?? 100;
    const interval = config.flushIntervalMs ?? 10_000;
    if (interval > 0) {
      this.timer = setInterval(() => {
        this.flush().catch((e: unknown) => {
          console.error("[llm-call-log-sink] Auto-flush error:", e);
        });
      }, interval);
      // Prevent the timer from keeping the process alive.
      if (typeof this.timer === "object" && "unref" in this.timer) {
        (this.timer as { unref: () => void }).unref();
      }
    }
  }

  async log(row: LlmCallLogRow): Promise<void> {
    this.buffer.push(row);
    if (this.buffer.length >= this.maxBatchSize) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const rows = this.buffer.splice(0, this.buffer.length);
    if (typeof this.inner.insertRows === "function") {
      await this.inner.insertRows(rows);
    } else {
      await Promise.all(rows.map((r) => this.inner.log(r)));
    }
  }

  /** Returns current buffer length (useful in tests). */
  get pendingCount(): number {
    return this.buffer.length;
  }

  /** Stops the auto-flush timer and flushes remaining rows. */
  async close(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    await this.flush();
  }
}
