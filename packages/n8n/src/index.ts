import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  n8nDispatchCallbackSchema,
  n8nTypedDispatchRequestSchema,
} from "./channel-contracts.js";

export * from "./channel-contracts.js";

export const n8nSignalTypeValues = [
  "competitive",
  "community",
  "icp",
  "product",
  "market",
  "internal",
] as const;

export const n8nSignalEnvelopeSchema = z.object({
  eventId: z.string().min(1).max(255),
  source: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9._:-]+$/),
  signalType: z.enum(n8nSignalTypeValues),
  occurredAt: z.string().datetime({ offset: true }),
  workflowId: z.string().min(1).max(255).optional(),
  executionId: z.string().min(1).max(255).optional(),
  payload: z.record(z.unknown()).default({}),
});

export type N8nSignalEnvelope = z.infer<typeof n8nSignalEnvelopeSchema>;

export const n8nDispatchRequestSchema = z.object({
  tenantId: z.string().uuid(),
  actionId: z.string().min(1).max(255),
  actionType: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z][a-z0-9._-]*$/),
  approvedBy: z.string().min(1).max(255),
  idempotencyKey: z.string().min(1).max(255),
  payload: z.record(z.unknown()).default({}),
  callback: n8nDispatchCallbackSchema.optional(),
});

export type N8nDispatchRequest = z.infer<typeof n8nDispatchRequestSchema>;

export interface N8nDispatchSuccess {
  ok: true;
  status: number;
  body: unknown;
}

export interface N8nDispatchFailure {
  ok: false;
  status: number | null;
  error: string;
  retryable: boolean;
  body?: unknown;
}

export type N8nDispatchResult = N8nDispatchSuccess | N8nDispatchFailure;

export interface N8nDispatchClientConfig {
  webhookUrl: string;
  timeoutMs?: number;
  /** Shared HMAC secret used to authenticate GrowthOS → n8n dispatches. */
  sharedSecret?: string;
}

const normalizeSignature = (signature: string): string =>
  signature.trim().startsWith("sha256=")
    ? signature.trim().slice("sha256=".length)
    : signature.trim();

export const signN8nPayload = (
  rawBody: string | Uint8Array,
  secret: string,
): string => createHmac("sha256", secret).update(rawBody).digest("hex");

export const verifyN8nSignature = (
  rawBody: string | Uint8Array,
  signature: string | null | undefined,
  secret: string,
): boolean => {
  if (!signature || !secret) return false;

  const normalized = normalizeSignature(signature);
  if (!/^[a-fA-F0-9]{64}$/.test(normalized)) return false;

  const expected = Buffer.from(signN8nPayload(rawBody, secret), "hex");
  const actual = Buffer.from(normalized, "hex");
  if (actual.length !== expected.length) return false;

  return timingSafeEqual(actual, expected);
};

const parseResponseBody = async (response: Response): Promise<unknown> => {
  const text = await response.text().catch(() => "");
  if (!text) return null;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

export interface N8nDispatchReceiptMetadata {
  workflowId?: string;
  executionId?: string;
  providerReference?: string;
}

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * n8n gateway responses vary by workflow. Keep the raw receipt for audit, but
 * lift common correlation IDs when they are present at either the root or a
 * conventional `data` envelope.
 */
export const extractN8nDispatchReceiptMetadata = (
  body: unknown,
): N8nDispatchReceiptMetadata => {
  const root =
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const nested =
    root.data !== null &&
    typeof root.data === "object" &&
    !Array.isArray(root.data)
      ? (root.data as Record<string, unknown>)
      : {};
  const get = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = nonEmptyString(root[key]) ?? nonEmptyString(nested[key]);
      if (value) return value;
    }
    return undefined;
  };
  const workflowId = get("workflowId", "workflow_id");
  const executionId = get("executionId", "execution_id");
  const providerReference = get(
    "providerReference",
    "provider_reference",
    "messageId",
    "message_id",
  );
  return {
    ...(workflowId !== undefined ? { workflowId } : {}),
    ...(executionId !== undefined ? { executionId } : {}),
    ...(providerReference !== undefined ? { providerReference } : {}),
  };
};

export class N8nDispatchClient {
  private readonly webhookUrl: string;
  private readonly timeoutMs: number;
  private readonly sharedSecret: string | null;

  constructor(
    config: N8nDispatchClientConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const parsed = z
      .object({
        webhookUrl: z.string().url(),
        timeoutMs: z.number().int().positive().default(10_000),
        sharedSecret: z.string().min(1).optional(),
      })
      .parse(config);

    this.webhookUrl = parsed.webhookUrl;
    this.timeoutMs = parsed.timeoutMs;
    this.sharedSecret = parsed.sharedSecret ?? null;
  }

  async dispatch(input: N8nDispatchRequest): Promise<N8nDispatchResult> {
    const request = n8nTypedDispatchRequestSchema.parse(input);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const rawBody = JSON.stringify(request);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "idempotency-key": request.idempotencyKey,
    };
    if (this.sharedSecret) {
      headers["x-growthos-signature"] = signN8nPayload(
        rawBody,
        this.sharedSecret,
      );
    }

    try {
      const response = await this.fetchImpl(this.webhookUrl, {
        method: "POST",
        headers,
        body: rawBody,
        signal: controller.signal,
      });
      const body = await parseResponseBody(response);

      if (response.ok) {
        return { ok: true, status: response.status, body };
      }

      return {
        ok: false,
        status: response.status,
        error: `n8n dispatch failed with HTTP ${response.status}`,
        retryable: response.status === 429 || response.status >= 500,
        ...(body !== null ? { body } : {}),
      };
    } catch (error) {
      const isAbort =
        error instanceof Error &&
        (error.name === "AbortError" || error.message.includes("aborted"));
      return {
        ok: false,
        status: null,
        error: error instanceof Error ? error.message : String(error),
        retryable: true,
        ...(isAbort ? { body: { reason: "timeout" } } : {}),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
