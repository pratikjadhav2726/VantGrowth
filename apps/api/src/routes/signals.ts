/**
 * POST /v1/signals — ingest an external signal event for a tenant.
 *
 * Signals flow:
 *   External source → POST /v1/signals → SignalEventsRepository.ingest()
 *     → signal_events (Postgres) → IntelDirectorWorker (polls listUnprocessed)
 *       → intel_brief.v1 NATS event → content pipeline
 *
 * **POST /v1/signals/grade** — LLM preview of signal quality (same pipeline as
 * `SignalRouter` grading). Does not persist; requires `OPENAI_API_KEY` or an
 * injected `LlmCallRunner` in tests.
 *
 * The ingest endpoint is idempotent: duplicate `externalId` values for the same
 * tenant return HTTP 202 with `inserted: false` and the existing signal's ID.
 */

import {
  type IngestSignalParams,
  type SignalEventsRepository,
  type SignalTypeValue,
  signalTypeValues,
} from "@growthos/db";
import { type LlmCallRunner, gradeSignalPayload } from "@growthos/llm-harness";
import { Hono } from "hono";
import { z } from "zod";
import { ServiceUnavailableError } from "../http-errors.js";

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

export const ingestSignalRequestSchema = z.object({
  /** Optional caller-assigned stable ID — used for idempotency within the tenant. */
  externalId: z.string().min(1).max(255).optional(),
  /**
   * Signal category — must match one of the known SignalTypeValues.
   */
  signalType: z.enum(
    signalTypeValues as unknown as [SignalTypeValue, ...SignalTypeValue[]],
  ),
  /** Human-readable source label, e.g. "twitter", "g2", "intercom" */
  source: z.string().min(1).max(100),
  /** When the signal occurred in the source system (ISO 8601) */
  occurredAt: z.string().datetime({ offset: true }).optional(),
  /** Free-form structured payload — preserved verbatim in JSONB. */
  payload: z.record(z.unknown()).optional(),
});

export const signalGradeRequestSchema = z.object({
  signalType: z.string().min(1).max(100),
  source: z.string().min(1).max(100),
  payload: z.record(z.unknown()).optional(),
  motionContext: z.string().max(2000).optional(),
});

export type SignalGradeRequest = z.infer<typeof signalGradeRequestSchema>;

// ---------------------------------------------------------------------------
// Route dependencies
// ---------------------------------------------------------------------------

export interface SignalRouteDependencies {
  signalEventsRepository: SignalEventsRepository | null;
  /** When unset or null, `POST /grade` returns 503. */
  llmCallRunner?: LlmCallRunner | null;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export const createSignalRoutes = (deps: SignalRouteDependencies): Hono => {
  const route = new Hono();

  /**
   * POST /v1/signals
   *
   * Headers:
   *   X-Tenant-Id: <uuid>  (required)
   *
   * Body: IngestSignalRequest (JSON)
   *
   * Response 202:
   *   { accepted: true, inserted: boolean, signalId: string, externalId: string }
   */
  route.post("/", async (c) => {
    if (!deps.signalEventsRepository) {
      throw new ServiceUnavailableError(
        "Signal events repository is not configured. Set DATABASE_URL.",
      );
    }

    const tenantId = c.req.header("X-Tenant-Id");
    if (!tenantId) {
      return c.json({ error: "X-Tenant-Id header is required" }, 400);
    }

    const body = ingestSignalRequestSchema.parse(await c.req.json());

    const params: IngestSignalParams = {
      tenantId,
      signalType: body.signalType,
      source: body.source,
      payload: body.payload ?? {},
      ...(body.externalId !== undefined ? { externalId: body.externalId } : {}),
    };

    const result = await deps.signalEventsRepository.ingest(params);

    return c.json(
      {
        accepted: true,
        inserted: !result.isDuplicate,
        signalId: result.event.id.toString(),
        externalId: result.event.externalId,
        tenantId: result.event.tenantId,
      },
      202,
    );
  });

  /**
   * POST /v1/signals/grade
   *
   * Headers: X-Tenant-Id (required)
   * Body: { signalType, source, payload?, motionContext? }
   *
   * Runs LLM signal quality grading (same pipeline as SignalRouter). Returns
   * `{ graded: boolean, grade: SignalGrade | null }` — `graded` is true when
   * the model returned a valid structured grade.
   */
  route.post("/grade", async (c) => {
    if (!deps.llmCallRunner) {
      throw new ServiceUnavailableError(
        "LLM runner is not configured. Set OPENAI_API_KEY for OpenAI-backed grading.",
      );
    }

    const tenantId = c.req.header("X-Tenant-Id");
    if (!tenantId) {
      return c.json({ error: "X-Tenant-Id header is required" }, 400);
    }

    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: "Request body must be valid JSON" }, 400);
    }

    const parsed = signalGradeRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid request",
          details: parsed.error.flatten().fieldErrors,
        },
        422,
      );
    }

    const grade = await gradeSignalPayload(
      {
        tenantId,
        signalType: parsed.data.signalType,
        source: parsed.data.source,
        payload: parsed.data.payload ?? {},
      },
      deps.llmCallRunner,
      parsed.data.motionContext ?? "inbound_content, plg",
    );

    return c.json(
      {
        graded: grade !== null,
        grade,
      },
      200,
    );
  });

  return route;
};
