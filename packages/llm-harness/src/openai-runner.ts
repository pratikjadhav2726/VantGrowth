/**
 * OpenAiLlmCallRunner — production LLM runner backed by the OpenAI Chat
 * Completions API.
 *
 * Features:
 *   - Automatic retry with exponential backoff on 429 / 5xx responses.
 *   - OTel span per call (`llm.chat.completions`) with model, token counts,
 *     latency, and cost attributes — compatible with the GenAI semantic
 *     conventions draft.
 *   - Cost estimation via a static per-model token pricing table.  The table
 *     is updated via `registerModelPricing()`; unknown models return $0.
 *   - Prompt-cache detection: marks `cached=true` when OpenAI returns a non-zero
 *     `cached_tokens` field in `usage.prompt_tokens_details`.
 *
 * The runner is injected into workers rather than used globally so it can be
 * swapped for StubLlmCallRunner in all unit tests.
 */

import { SpanKind, SpanStatusCode, getTracer } from "@growthos/observability";
import OpenAI from "openai";
import { type LlmCallLogSink, buildLogRow } from "./llm-call-log-sink.js";
import type {
  LlmCallResult,
  LlmCallRunOptions,
  LlmCallRunner,
} from "./llm-call-runner.js";
import type { PromptTemplate } from "./prompt-template.js";

// ---------------------------------------------------------------------------
// Token pricing table (USD per 1 000 tokens)
// ---------------------------------------------------------------------------

export interface ModelPricing {
  inputPer1k: number;
  outputPer1k: number;
}

const MODEL_PRICING: Map<string, ModelPricing> = new Map([
  ["gpt-4o", { inputPer1k: 0.005, outputPer1k: 0.015 }],
  ["gpt-4o-mini", { inputPer1k: 0.00015, outputPer1k: 0.0006 }],
  ["gpt-4-turbo", { inputPer1k: 0.01, outputPer1k: 0.03 }],
  ["gpt-3.5-turbo", { inputPer1k: 0.0005, outputPer1k: 0.0015 }],
  ["o1-mini", { inputPer1k: 0.003, outputPer1k: 0.012 }],
  ["o3-mini", { inputPer1k: 0.0011, outputPer1k: 0.0044 }],
]);

/** Registers or overrides pricing for a model (useful when new models launch). */
export const registerModelPricing = (
  model: string,
  pricing: ModelPricing,
): void => {
  MODEL_PRICING.set(model, pricing);
};

const estimateCost = (
  model: string,
  inputTokens: number,
  outputTokens: number,
): number => {
  const pricing = MODEL_PRICING.get(model);
  if (!pricing) return 0;
  return (
    (inputTokens / 1000) * pricing.inputPer1k +
    (outputTokens / 1000) * pricing.outputPer1k
  );
};

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const isRetryable = (err: unknown): boolean => {
  if (err instanceof OpenAI.APIError) {
    return err.status === 429 || (err.status >= 500 && err.status < 600);
  }
  return false;
};

const withRetry = async <T>(
  fn: () => Promise<T>,
  retries: number,
  baseDelayMs: number,
): Promise<T> => {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries && isRetryable(err)) {
        await sleep(baseDelayMs * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
};

// ---------------------------------------------------------------------------
// OpenAiLlmCallRunnerConfig
// ---------------------------------------------------------------------------

export interface OpenAiLlmCallRunnerConfig {
  /** Default model name.  Can be overridden per-call via LlmCallRunOptions. */
  defaultModel?: string;
  /** Default sampling temperature. Default: 0.7 */
  defaultTemperature?: number;
  /** Default max_tokens. Default: 2048 */
  defaultMaxTokens?: number;
  /** Default retry count. Default: 3 */
  defaultRetries?: number;
  /** Base delay for exponential backoff. Default: 500ms */
  defaultRetryBaseDelayMs?: number;
  /**
   * Optional sink for recording LLM call logs (tokens, cost, latency).
   * When provided, a log row is written after every successful call.
   * Sink failures are swallowed — they never propagate to callers.
   */
  logSink?: LlmCallLogSink;
}

// ---------------------------------------------------------------------------
// OpenAiLlmCallRunner
// ---------------------------------------------------------------------------

export class OpenAiLlmCallRunner implements LlmCallRunner {
  private readonly client: OpenAI;
  private readonly config: Required<OpenAiLlmCallRunnerConfig>;
  private readonly tracer = getTracer("growthos.llm-harness");

  constructor(client?: OpenAI, config: OpenAiLlmCallRunnerConfig = {}) {
    this.client = client ?? new OpenAI();
    this.config = {
      defaultModel: config.defaultModel ?? "gpt-4o-mini",
      defaultTemperature: config.defaultTemperature ?? 0.7,
      defaultMaxTokens: config.defaultMaxTokens ?? 2048,
      defaultRetries: config.defaultRetries ?? 3,
      defaultRetryBaseDelayMs: config.defaultRetryBaseDelayMs ?? 500,
      ...(config.logSink !== undefined ? { logSink: config.logSink } : {}),
    } as Required<OpenAiLlmCallRunnerConfig>;
  }

  static fromEnv(config: OpenAiLlmCallRunnerConfig = {}): OpenAiLlmCallRunner {
    // OpenAI() automatically reads OPENAI_API_KEY from env.
    return new OpenAiLlmCallRunner(new OpenAI(), config);
  }

  async run<TVars extends Record<string, unknown>>(
    template: PromptTemplate<TVars>,
    vars: TVars,
    options?: LlmCallRunOptions,
  ): Promise<LlmCallResult> {
    const model = options?.model ?? this.config.defaultModel;
    const temperature = options?.temperature ?? this.config.defaultTemperature;
    const maxTokens = options?.maxTokens ?? this.config.defaultMaxTokens;
    const retries = options?.retries ?? this.config.defaultRetries;
    const retryBaseDelayMs =
      options?.retryBaseDelayMs ?? this.config.defaultRetryBaseDelayMs;

    const userMessage = template.render(vars);
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (template.system) {
      messages.push({ role: "system", content: template.system });
    }
    messages.push({ role: "user", content: userMessage });

    const span = this.tracer.startSpan("llm.chat.completions", {
      kind: SpanKind.CLIENT,
      attributes: {
        "llm.model": model,
        "llm.prompt_id": template.id,
        "llm.prompt_version": template.version,
      },
    });

    const startMs = Date.now();
    let result: LlmCallResult;

    try {
      const response = await withRetry(
        () =>
          this.client.chat.completions.create({
            model,
            messages,
            temperature,
            max_tokens: maxTokens,
          }),
        retries,
        retryBaseDelayMs,
      );

      const latencyMs = Date.now() - startMs;
      const usage = response.usage;
      const inputTokens = usage?.prompt_tokens ?? 0;
      const outputTokens = usage?.completion_tokens ?? 0;

      // Detect OpenAI prompt-cache hit via usage.prompt_tokens_details.
      const cachedTokens =
        (usage as { prompt_tokens_details?: { cached_tokens?: number } })
          ?.prompt_tokens_details?.cached_tokens ?? 0;
      const cached = cachedTokens > 0;

      const costUsd = estimateCost(model, inputTokens, outputTokens);
      const content = response.choices[0]?.message?.content ?? "";

      span.setAttributes({
        "llm.input_tokens": inputTokens,
        "llm.output_tokens": outputTokens,
        "llm.latency_ms": latencyMs,
        "llm.cost_usd": costUsd,
        "llm.cached": cached,
      });
      span.setStatus({ code: SpanStatusCode.OK });

      result = {
        content,
        model,
        inputTokens,
        outputTokens,
        latencyMs,
        costUsd,
        cached,
        promptVersion: template.version,
      };
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }

    // Write to log sink after the span ends.  Sink failures are swallowed.
    if (this.config.logSink) {
      const logRow = buildLogRow("unknown", template.id, result);
      this.config.logSink.log(logRow).catch((e: unknown) => {
        console.error(
          "[llm-harness] log sink error:",
          e instanceof Error ? e.message : String(e),
        );
      });
    }

    return result;
  }
}
