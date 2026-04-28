import OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmCallLogRow, LlmCallLogSink } from "./llm-call-log-sink.js";
import { StubLlmCallRunner } from "./llm-call-runner.js";
import { OpenAiLlmCallRunner, registerModelPricing } from "./openai-runner.js";
import {
  BLOG_DRAFT_GENERATE_PROMPT,
  CONTENT_BRIEF_GENERATE_PROMPT,
  INTEL_BRIEF_GENERATE_PROMPT,
  definePrompt,
  promptTemplateMetaSchema,
} from "./prompt-template.js";

// ---------------------------------------------------------------------------
// PromptTemplate
// ---------------------------------------------------------------------------

describe("definePrompt", () => {
  it("returns a valid template with the supplied config", () => {
    const t = definePrompt<{ topic: string }>({
      id: "test.prompt",
      version: "1.0.0",
      render: ({ topic }) => `Write about ${topic}.`,
    });
    expect(t.id).toBe("test.prompt");
    expect(t.version).toBe("1.0.0");
    expect(t.render({ topic: "PLG" })).toBe("Write about PLG.");
  });

  it("throws on invalid id format", () => {
    expect(() =>
      definePrompt({ id: "has spaces", version: "1.0.0", render: () => "" }),
    ).toThrow();
  });

  it("throws on invalid version format", () => {
    expect(() =>
      definePrompt({ id: "valid.id", version: "v1", render: () => "" }),
    ).toThrow();
  });

  it("promptTemplateMetaSchema accepts valid id + version", () => {
    expect(() =>
      promptTemplateMetaSchema.parse({
        id: "intel-brief.generate",
        version: "1.0.0",
      }),
    ).not.toThrow();
  });
});

describe("built-in prompt templates", () => {
  it("INTEL_BRIEF_GENERATE_PROMPT renders without throwing", () => {
    const result = INTEL_BRIEF_GENERATE_PROMPT.render({
      tenantId: "tenant-1",
      periodFrom: "2026-04-01",
      periodTo: "2026-04-28",
      motionContext: "PLG primary",
    });
    expect(result).toContain("2026-04-01");
    expect(result).toContain("PLG primary");
  });

  it("CONTENT_BRIEF_GENERATE_PROMPT renders without throwing", () => {
    const result = CONTENT_BRIEF_GENERATE_PROMPT.render({
      opportunityTitle: "Why PLG wins",
      motionFit: "plg",
      hook: "Product-led growth is non-negotiable.",
      targetAudience: "B2B founders",
    });
    expect(result).toContain("Why PLG wins");
  });

  it("BLOG_DRAFT_GENERATE_PROMPT renders without throwing", () => {
    const result = BLOG_DRAFT_GENERATE_PROMPT.render({
      title: "PLG for B2B",
      hook: "This changes everything.",
      outline: "1. Intro 2. Core 3. Evidence",
      toneNotes: "First person, direct.",
      primaryKeyword: "plg-saas",
    });
    expect(result).toContain("PLG for B2B");
  });
});

// ---------------------------------------------------------------------------
// StubLlmCallRunner
// ---------------------------------------------------------------------------

describe("StubLlmCallRunner", () => {
  const sampleTemplate = definePrompt<{ name: string }>({
    id: "test.sample",
    version: "2.1.0",
    render: ({ name }) => `Hello, ${name}!`,
  });

  it("returns the configured string response", async () => {
    const runner = new StubLlmCallRunner({
      "test.sample": "Stubbed response.",
    });
    const result = await runner.run(sampleTemplate, { name: "Alice" });
    expect(result.content).toBe("Stubbed response.");
  });

  it("returns the factory function response", async () => {
    const runner = new StubLlmCallRunner({
      "test.sample": ({ name }) => `Hi ${name} from factory!`,
    });
    const result = await runner.run(sampleTemplate, { name: "Bob" });
    expect(result.content).toBe("Hi Bob from factory!");
  });

  it("returns the default stub response when template has no configured response", async () => {
    const runner = new StubLlmCallRunner();
    const result = await runner.run(sampleTemplate, { name: "Carol" });
    expect(result.content).toContain("[stub:test.sample]");
    expect(result.content).toContain("2.1.0");
  });

  it("records calls in callHistory", async () => {
    const runner = new StubLlmCallRunner();
    await runner.run(sampleTemplate, { name: "Alice" });
    await runner.run(sampleTemplate, { name: "Bob" });
    expect(runner.callCount).toBe(2);
    expect(runner.callHistory[0]?.vars).toEqual({ name: "Alice" });
  });

  it("callsFor filters by templateId", async () => {
    const other = definePrompt({
      id: "other.template",
      version: "1.0.0",
      render: () => "",
    });
    const runner = new StubLlmCallRunner();
    await runner.run(sampleTemplate, { name: "X" });
    await runner.run(other, {});
    expect(runner.callsFor("test.sample")).toHaveLength(1);
    expect(runner.callsFor("other.template")).toHaveLength(1);
  });

  it("reset clears callHistory", async () => {
    const runner = new StubLlmCallRunner();
    await runner.run(sampleTemplate, { name: "X" });
    runner.reset();
    expect(runner.callCount).toBe(0);
  });

  it("propagates promptVersion from the template", async () => {
    const runner = new StubLlmCallRunner();
    const result = await runner.run(sampleTemplate, { name: "X" });
    expect(result.promptVersion).toBe("2.1.0");
  });

  it("respects model override from options", async () => {
    const runner = new StubLlmCallRunner();
    const result = await runner.run(
      sampleTemplate,
      { name: "X" },
      { model: "gpt-4o" },
    );
    expect(result.model).toBe("gpt-4o");
  });

  it("stub latency is 0 (no real I/O)", async () => {
    const runner = new StubLlmCallRunner();
    const result = await runner.run(sampleTemplate, { name: "X" });
    expect(result.latencyMs).toBe(0);
    expect(result.costUsd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// OpenAiLlmCallRunner — unit tests with mocked client
// ---------------------------------------------------------------------------

const makeOpenAiMock = (
  content = "Generated content",
  usage = { prompt_tokens: 120, completion_tokens: 60, total_tokens: 180 },
  model = "gpt-4o-mini",
) => {
  const client = {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content } }],
          usage,
          model,
        }),
      },
    },
  } as unknown as OpenAI;
  return client;
};

describe("OpenAiLlmCallRunner", () => {
  const template = definePrompt<{ question: string }>({
    id: "test.openai",
    version: "1.0.0",
    system: "You are helpful.",
    render: ({ question }) => question,
  });

  it("returns LlmCallResult with correct fields", async () => {
    const client = makeOpenAiMock("The answer is 42.");
    const runner = new OpenAiLlmCallRunner(client);
    const result = await runner.run(template, { question: "What is 6x7?" });
    expect(result.content).toBe("The answer is 42.");
    expect(result.model).toBe("gpt-4o-mini");
    expect(result.inputTokens).toBe(120);
    expect(result.outputTokens).toBe(60);
    expect(result.promptVersion).toBe("1.0.0");
  });

  it("computes costUsd from token pricing table", async () => {
    const client = makeOpenAiMock("ok");
    const runner = new OpenAiLlmCallRunner(client, { defaultModel: "gpt-4o" });
    const result = await runner.run(template, { question: "?" });
    // gpt-4o: $0.005/1k input + $0.015/1k output
    // 120 input = 0.12 * $0.005 = 0.0006
    // 60 output = 0.06 * $0.015 = 0.0009
    // total ≈ $0.0015
    expect(result.costUsd).toBeCloseTo(0.0015, 4);
  });

  it("returns costUsd=0 for unknown models", async () => {
    const client = makeOpenAiMock("ok", undefined, "unknown-model-xyz");
    const runner = new OpenAiLlmCallRunner(client, {
      defaultModel: "unknown-model-xyz",
    });
    const result = await runner.run(template, { question: "?" });
    expect(result.costUsd).toBe(0);
  });

  it("detects cached=false when cached_tokens is absent", async () => {
    const client = makeOpenAiMock();
    const runner = new OpenAiLlmCallRunner(client);
    const result = await runner.run(template, { question: "?" });
    expect(result.cached).toBe(false);
  });

  it("retries on 429 and eventually succeeds", async () => {
    let calls = 0;
    const client = {
      chat: {
        completions: {
          create: vi.fn().mockImplementation(async () => {
            calls++;
            if (calls < 3) {
              throw Object.assign(
                new OpenAI.APIError(
                  429,
                  { message: "rate limited" },
                  "rate limited",
                  {},
                ),
                { status: 429 },
              );
            }
            return {
              choices: [{ message: { content: "ok" } }],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 15,
              },
              model: "gpt-4o-mini",
            };
          }),
        },
      },
    } as unknown as OpenAI;

    const runner = new OpenAiLlmCallRunner(client, {
      defaultRetries: 3,
      defaultRetryBaseDelayMs: 1,
    });
    const result = await runner.run(template, { question: "?" });
    expect(result.content).toBe("ok");
    expect(calls).toBe(3);
  });

  it("throws after exhausting retries on persistent 5xx", async () => {
    const client = {
      chat: {
        completions: {
          create: vi
            .fn()
            .mockRejectedValue(
              Object.assign(
                new OpenAI.APIError(
                  503,
                  { message: "service unavailable" },
                  "service unavailable",
                  {},
                ),
                { status: 503 },
              ),
            ),
        },
      },
    } as unknown as OpenAI;

    const runner = new OpenAiLlmCallRunner(client, {
      defaultRetries: 2,
      defaultRetryBaseDelayMs: 1,
    });
    await expect(runner.run(template, { question: "?" })).rejects.toThrow();
  });

  it("does not retry on 400 bad request", async () => {
    let calls = 0;
    const client = {
      chat: {
        completions: {
          create: vi.fn().mockImplementation(async () => {
            calls++;
            throw Object.assign(
              new OpenAI.APIError(
                400,
                { message: "bad request" },
                "bad request",
                {},
              ),
              { status: 400 },
            );
          }),
        },
      },
    } as unknown as OpenAI;

    const runner = new OpenAiLlmCallRunner(client, {
      defaultRetries: 3,
      defaultRetryBaseDelayMs: 1,
    });
    await expect(runner.run(template, { question: "?" })).rejects.toThrow();
    expect(calls).toBe(1); // no retries
  });
});

// ---------------------------------------------------------------------------
// LlmCallRunOptions.tenantId / agentId / issueId context propagation
// ---------------------------------------------------------------------------

describe("OpenAiLlmCallRunner tenantId context forwarding", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes tenantId and agentId to logSink when provided in options", async () => {
    const capturedRows: LlmCallLogRow[] = [];
    const sink: LlmCallLogSink = {
      log: async (row) => {
        capturedRows.push(row);
      },
      flush: async () => {},
    };

    const client = makeOpenAiMock("result", {
      prompt_tokens: 50,
      completion_tokens: 20,
      total_tokens: 70,
    });
    const runner = new OpenAiLlmCallRunner(client, { logSink: sink });

    await runner.run(
      definePrompt({ id: "ctx.test", version: "1.0.0", render: () => "test" }),
      {},
      { tenantId: "00000000-0000-4000-8000-000000000011", agentId: "agent-99" },
    );

    expect(capturedRows).toHaveLength(1);
    const row = capturedRows[0];
    if (!row) throw new Error("Expected a log row");
    expect(row.tenantId).toBe("00000000-0000-4000-8000-000000000011");
    expect(row.agentId).toBe("agent-99");
  });

  it("uses 'unknown' tenantId when not provided in options", async () => {
    const capturedRows: LlmCallLogRow[] = [];
    const sink: LlmCallLogSink = {
      log: async (row) => {
        capturedRows.push(row);
      },
      flush: async () => {},
    };

    const client = makeOpenAiMock("result", {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
    const runner = new OpenAiLlmCallRunner(client, { logSink: sink });

    await runner.run(
      definePrompt({ id: "ctx.noTenant", version: "1.0.0", render: () => "x" }),
      {},
    );

    expect(capturedRows[0]?.tenantId).toBe("unknown");
    expect("agentId" in (capturedRows[0] ?? {})).toBe(false);
  });

  it("forwards issueId to log row when supplied", async () => {
    const capturedRows: LlmCallLogRow[] = [];
    const sink: LlmCallLogSink = {
      log: async (row) => {
        capturedRows.push(row);
      },
      flush: async () => {},
    };

    const client = makeOpenAiMock("result", {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
    const runner = new OpenAiLlmCallRunner(client, { logSink: sink });

    await runner.run(
      definePrompt({ id: "ctx.issue", version: "1.0.0", render: () => "x" }),
      {},
      {
        tenantId: "t-1",
        issueId: "00000000-0000-4000-8000-000000000999",
      },
    );

    expect(capturedRows[0]?.issueId).toBe(
      "00000000-0000-4000-8000-000000000999",
    );
  });
});

// ---------------------------------------------------------------------------
// registerModelPricing
// ---------------------------------------------------------------------------

describe("registerModelPricing", () => {
  afterEach(() => {
    // No cleanup needed — map is module-level but tests don't conflict
  });

  it("registers a new model and uses it for cost calculation", async () => {
    registerModelPricing("growthos-test-model", {
      inputPer1k: 0.001,
      outputPer1k: 0.002,
    });
    const client = makeOpenAiMock(
      "ok",
      { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 },
      "growthos-test-model",
    );
    const runner = new OpenAiLlmCallRunner(client, {
      defaultModel: "growthos-test-model",
    });
    const result = await runner.run(
      definePrompt({ id: "pricing.test", version: "1.0.0", render: () => "?" }),
      {},
    );
    expect(result.costUsd).toBeCloseTo(0.003, 4); // 1k input @ $0.001 + 1k output @ $0.002
  });
});
