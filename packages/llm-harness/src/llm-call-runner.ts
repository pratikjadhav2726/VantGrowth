/**
 * LlmCallRunner — the core abstraction for all LLM interactions in GrowthOS.
 *
 * Every worker that issues an LLM call must go through this interface.  This
 * ensures that:
 *   - Tests use StubLlmCallRunner and never hit the network.
 *   - Production uses OpenAiLlmCallRunner with automatic retry, OTel spans,
 *     and cost tracking.
 *   - Swapping models or providers is a one-line constructor change.
 *
 * LlmCallLog rows are written to ClickHouse (not Postgres) by the caller or
 * a background sink.  The runner returns all fields needed to build a log row.
 */

import type { PromptTemplate } from "./prompt-template.js";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface LlmCallRunOptions {
  /** Overrides the runner's default model (e.g. "gpt-4o-mini" for cost saving) */
  model?: string;
  /** Sampling temperature [0, 2]. Default: 0.7 */
  temperature?: number;
  /** Max completion tokens. Default: runner-determined */
  maxTokens?: number;
  /** Number of retries on transient errors. Default: 3 */
  retries?: number;
  /** Base delay for exponential backoff in ms. Default: 500 */
  retryBaseDelayMs?: number;
}

export interface LlmCallResult {
  /** Generated text content */
  content: string;
  /** Model used (may differ from requested if the runner normalises aliases) */
  model: string;
  /** Input token count (prompt) */
  inputTokens: number;
  /** Output token count (completion) */
  outputTokens: number;
  /** Wall-clock latency in milliseconds */
  latencyMs: number;
  /** Estimated cost in USD based on static token pricing table */
  costUsd: number;
  /** True when the provider served the result from its prompt cache */
  cached: boolean;
  /** Version string from the PromptTemplate used */
  promptVersion: string;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface LlmCallRunner {
  run<TVars extends Record<string, unknown>>(
    template: PromptTemplate<TVars>,
    vars: TVars,
    options?: LlmCallRunOptions,
  ): Promise<LlmCallResult>;
}

// ---------------------------------------------------------------------------
// StubLlmCallRunner — deterministic test double
// ---------------------------------------------------------------------------

export type StubResponseFactory =
  | string
  | ((vars: Record<string, unknown>) => string);

export interface StubCall {
  templateId: string;
  vars: Record<string, unknown>;
  result: LlmCallResult;
}

/**
 * Deterministic test double for LlmCallRunner.
 *
 * Configure per-template responses via the constructor map.  Useful for unit
 * tests that assert on downstream behaviour without hitting the OpenAI API.
 *
 * All calls are recorded in `callHistory` for inspection.
 */
export class StubLlmCallRunner implements LlmCallRunner {
  readonly callHistory: StubCall[] = [];

  constructor(
    private readonly responses: Record<string, StubResponseFactory> = {},
    private readonly defaultModel = "stub-model",
  ) {}

  async run<TVars extends Record<string, unknown>>(
    template: PromptTemplate<TVars>,
    vars: TVars,
    options?: LlmCallRunOptions,
  ): Promise<LlmCallResult> {
    const responseFactory = this.responses[template.id];
    const content =
      responseFactory !== undefined
        ? typeof responseFactory === "function"
          ? responseFactory(vars as Record<string, unknown>)
          : responseFactory
        : `[stub:${template.id}] Default stub response for version ${template.version}`;

    const result: LlmCallResult = {
      content,
      model: options?.model ?? this.defaultModel,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      costUsd: 0,
      cached: false,
      promptVersion: template.version,
    };

    this.callHistory.push({
      templateId: template.id,
      vars: vars as Record<string, unknown>,
      result,
    });

    return result;
  }

  /** Returns the total number of calls made (useful in test assertions). */
  get callCount(): number {
    return this.callHistory.length;
  }

  /** Returns all calls for a specific template id. */
  callsFor(templateId: string): StubCall[] {
    return this.callHistory.filter((c) => c.templateId === templateId);
  }

  /** Resets call history between tests. */
  reset(): void {
    this.callHistory.length = 0;
  }
}
