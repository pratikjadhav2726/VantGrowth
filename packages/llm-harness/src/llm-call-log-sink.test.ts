import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BufferedLlmCallLogSink,
  ClickHouseLlmCallLogSink,
  type LlmCallLogRow,
  type LlmCallLogSink,
  NoopLlmCallLogSink,
  buildLogRow,
} from "./llm-call-log-sink.js";
import type { LlmCallResult } from "./llm-call-runner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeResult = (overrides: Partial<LlmCallResult> = {}): LlmCallResult => ({
  content: "Generated output",
  model: "gpt-4o-mini",
  inputTokens: 100,
  outputTokens: 50,
  latencyMs: 320,
  costUsd: 0.00023,
  cached: false,
  promptVersion: "1.0.0",
  ...overrides,
});

const makeRow = (overrides: Partial<LlmCallLogRow> = {}): LlmCallLogRow => ({
  tenantId: "00000000-0000-4000-8000-000000000001",
  promptId: "blog-draft.generate",
  promptVersion: "1.0.0",
  model: "gpt-4o-mini",
  inputTokens: 100,
  outputTokens: 50,
  latencyMs: 320,
  costUsd: 0.00023,
  cached: false,
  calledAt: new Date("2026-04-28T10:00:00.000Z"),
  ...overrides,
});

// ---------------------------------------------------------------------------
// buildLogRow
// ---------------------------------------------------------------------------

describe("buildLogRow", () => {
  it("maps LlmCallResult fields correctly", () => {
    const result = makeResult({ inputTokens: 200, outputTokens: 80 });
    const row = buildLogRow("tenant-abc", "blog-draft.generate", result);
    expect(row.tenantId).toBe("tenant-abc");
    expect(row.promptId).toBe("blog-draft.generate");
    expect(row.promptVersion).toBe("1.0.0");
    expect(row.model).toBe("gpt-4o-mini");
    expect(row.inputTokens).toBe(200);
    expect(row.outputTokens).toBe(80);
    expect(row.latencyMs).toBe(320);
    expect(row.costUsd).toBe(0.00023);
    expect(row.cached).toBe(false);
  });

  it("propagates optional agentId and issueId", () => {
    const row = buildLogRow("t", "p", makeResult(), {
      agentId: "agent-1",
      issueId: "issue-1",
    });
    expect(row.agentId).toBe("agent-1");
    expect(row.issueId).toBe("issue-1");
  });

  it("omits agentId/issueId when not provided", () => {
    const row = buildLogRow("t", "p", makeResult());
    expect("agentId" in row).toBe(false);
    expect("issueId" in row).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NoopLlmCallLogSink
// ---------------------------------------------------------------------------

describe("NoopLlmCallLogSink", () => {
  it("log resolves without error", async () => {
    const sink = new NoopLlmCallLogSink();
    await expect(sink.log(makeRow())).resolves.toBeUndefined();
  });

  it("flush resolves without error", async () => {
    const sink = new NoopLlmCallLogSink();
    await expect(sink.flush()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// BufferedLlmCallLogSink
// ---------------------------------------------------------------------------

class CaptureSink implements LlmCallLogSink {
  readonly captured: LlmCallLogRow[][] = [];

  async log(row: LlmCallLogRow): Promise<void> {
    this.captured.push([row]);
  }

  async insertRows(rows: LlmCallLogRow[]): Promise<void> {
    this.captured.push(rows);
  }

  async flush(): Promise<void> {}
}

describe("BufferedLlmCallLogSink", () => {
  it("accumulates rows without flushing until maxBatchSize", async () => {
    const inner = new CaptureSink();
    const sink = new BufferedLlmCallLogSink({
      sink: inner,
      maxBatchSize: 3,
      flushIntervalMs: 0,
    });

    await sink.log(makeRow());
    await sink.log(makeRow());
    expect(inner.captured).toHaveLength(0);
    expect(sink.pendingCount).toBe(2);

    await sink.log(makeRow()); // triggers auto-flush at maxBatchSize=3
    expect(inner.captured).toHaveLength(1);
    expect(inner.captured[0]).toHaveLength(3);
    expect(sink.pendingCount).toBe(0);
  });

  it("flushes all buffered rows on explicit flush()", async () => {
    const inner = new CaptureSink();
    const sink = new BufferedLlmCallLogSink({
      sink: inner,
      maxBatchSize: 100,
      flushIntervalMs: 0,
    });

    await sink.log(makeRow());
    await sink.log(makeRow());
    expect(sink.pendingCount).toBe(2);

    await sink.flush();
    expect(inner.captured).toHaveLength(1);
    expect(inner.captured[0]).toHaveLength(2);
    expect(sink.pendingCount).toBe(0);
  });

  it("flush() on empty buffer is a no-op", async () => {
    const inner = new CaptureSink();
    const sink = new BufferedLlmCallLogSink({
      sink: inner,
      flushIntervalMs: 0,
    });
    await sink.flush();
    expect(inner.captured).toHaveLength(0);
  });

  it("close() flushes remaining rows and stops timer", async () => {
    const inner = new CaptureSink();
    const sink = new BufferedLlmCallLogSink({
      sink: inner,
      maxBatchSize: 100,
      flushIntervalMs: 0,
    });

    await sink.log(makeRow());
    await sink.close();
    expect(inner.captured).toHaveLength(1);
    expect(sink.pendingCount).toBe(0);
  });

  it("uses insertRows() batch method when available", async () => {
    const insertRowsSpy = vi.fn().mockResolvedValue(undefined);
    const inner: LlmCallLogSink & { insertRows: typeof insertRowsSpy } = {
      log: vi.fn().mockResolvedValue(undefined),
      flush: vi.fn().mockResolvedValue(undefined),
      insertRows: insertRowsSpy,
    };
    const sink = new BufferedLlmCallLogSink({
      sink: inner,
      flushIntervalMs: 0,
    });

    await sink.log(makeRow());
    await sink.log(makeRow());
    await sink.flush();

    expect(insertRowsSpy).toHaveBeenCalledOnce();
    expect(insertRowsSpy).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ promptId: "blog-draft.generate" }),
      ]),
    );
    expect(inner.log).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ClickHouseLlmCallLogSink
// ---------------------------------------------------------------------------

describe("ClickHouseLlmCallLogSink", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a POST to the ClickHouse HTTP API with JSONEachRow format", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue(new Response(null, { status: 200 }));

    const sink = new ClickHouseLlmCallLogSink({
      baseUrl: "http://localhost:8123",
      database: "growthos",
    });
    await sink.insertRows([makeRow()]);

    expect(mockFetch).toHaveBeenCalledOnce();
    const firstCall = mockFetch.mock.calls[0];
    if (!firstCall) throw new Error("fetch was not called");
    const [url, init] = firstCall;
    expect(url).toContain("INSERT+INTO+growthos.llm_call_logs");
    expect(init?.method).toBe("POST");
    const body = init?.body as string;
    expect(body).toContain("blog-draft.generate");
  });

  it("swallows non-200 responses without throwing", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("Service Unavailable", { status: 503 }),
    );

    const sink = new ClickHouseLlmCallLogSink({ baseUrl: "http://ch:8123" });
    await expect(sink.insertRows([makeRow()])).resolves.toBeUndefined();
  });

  it("swallows network errors without throwing", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("connection refused"));

    const sink = new ClickHouseLlmCallLogSink({ baseUrl: "http://ch:8123" });
    await expect(sink.insertRows([makeRow()])).resolves.toBeUndefined();
  });

  it("fromEnv() throws when CLICKHOUSE_URL is absent", () => {
    expect(() =>
      ClickHouseLlmCallLogSink.fromEnv({ CLICKHOUSE_URL: undefined }),
    ).toThrow("CLICKHOUSE_URL");
  });

  it("fromEnv() constructs from CLICKHOUSE_URL env var", () => {
    expect(() =>
      ClickHouseLlmCallLogSink.fromEnv({ CLICKHOUSE_URL: "http://ch:8123" }),
    ).not.toThrow();
  });

  it("is a no-op when rows array is empty", async () => {
    const mockFetch = vi.mocked(fetch);
    const sink = new ClickHouseLlmCallLogSink({ baseUrl: "http://ch:8123" });
    await sink.insertRows([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
