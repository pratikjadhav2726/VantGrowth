/**
 * POST /v1/signals — ingest an external signal event for a tenant.
 *
 * Signals flow:
 *   External source → POST /v1/signals → SignalEventsRepository.ingest()
 *     → signal_events (Postgres) → IntelDirectorWorker (polls listUnprocessed)
 *       → intel_brief.v1 NATS event → content pipeline
 *
 * The endpoint is idempotent: duplicate `externalId` values for the same
 * tenant return HTTP 200 with `inserted: false` and the existing signal's ID.
 */

import {
  type IngestSignalParams,
  type SignalEventsRepository,
  type SignalTypeValue,
  signalTypeValues,
} from "@growthos/db";
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

export type IngestSignalRequest = z.infer<typeof ingestSignalRequestSchema>;

// ---------------------------------------------------------------------------
// Route dependencies
// ---------------------------------------------------------------------------

export interface SignalRouteDependencies {
  signalEventsRepository: SignalEventsRepository | null;
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

  return route;
};
