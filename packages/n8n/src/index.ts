import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

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

export class N8nDispatchClient {
  private readonly webhookUrl: string;
  private readonly timeoutMs: number;

  constructor(
    config: N8nDispatchClientConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const parsed = z
      .object({
        webhookUrl: z.string().url(),
        timeoutMs: z.number().int().positive().default(10_000),
      })
      .parse(config);

    this.webhookUrl = parsed.webhookUrl;
    this.timeoutMs = parsed.timeoutMs;
  }

  async dispatch(input: N8nDispatchRequest): Promise<N8nDispatchResult> {
    const request = n8nDispatchRequestSchema.parse(input);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": request.idempotencyKey,
        },
        body: JSON.stringify(request),
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
