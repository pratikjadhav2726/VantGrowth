/**
 * IntelDirectorWorker — Phase 1 / S3
 *
 * Processes `intel_brief_requested.v1` events, generates a structured
 * IntelBriefV1 payload, and emits it via the Postgres outbox + NATS.
 *
 * Phase 1 design: the brief generator is deterministic — it builds a
 * structurally valid, schema-conforming IntelBriefV1 from the motion context
 * supplied in the request.  Competitive and community signals are empty in
 * this phase; the content_opportunities array contains one baseline
 * opportunity derived from the tenant's primary motion.
 *
 * Production path (Phase 1 S5+): replace `generateDeterministicBrief()` with
 * an LLM-backed variant that calls the signal store and competitive scanner.
 * The outbox contract and NATS subjects are stable across this upgrade.
 *
 * Idempotency: the outbox UNIQUE(tenant_id, event_type, idempotency_key)
 * constraint silently discards a re-delivered brief for the same request_id.
 */

import {
  type BriefOpportunityRef,
  type IntelBriefV1,
  type MotionLabel,
  intelBriefV1Schema,
  motionLabelSchema,
} from "@growthos/core";
import type { OutboxRepository } from "@growthos/db";
import { tenantScopedSubject } from "@growthos/db";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

export const intelBriefRequestedV1Schema = z.object({
  schema_version: z.literal("intel_brief_requested.v1"),
  request_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  period_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD"),
  period_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD"),
  requested_by: z.string().min(1).default("system"),
  motion_context: z
    .object({
      primary_motions: z.array(motionLabelSchema).default([]),
      icp_summary: z.string().optional(),
    })
    .optional(),
});

export type IntelBriefRequestedV1 = z.infer<typeof intelBriefRequestedV1Schema>;

// ---------------------------------------------------------------------------
// Outbox command builder
// ---------------------------------------------------------------------------

export const createIntelBriefOutboxCommand = (params: {
  tenantId: string;
  requestId: string;
  brief: IntelBriefV1;
}) => ({
  tenantId: params.tenantId,
  eventType: "intel_brief.v1",
  idempotencyKey: `intel-brief:${params.requestId}`,
  payload: params.brief as unknown as Record<string, unknown>,
});

// ---------------------------------------------------------------------------
// Deterministic brief generator
// ---------------------------------------------------------------------------

const DEFAULT_MOTION: MotionLabel = "inbound_content";

/**
 * Generates a structurally-valid IntelBriefV1 without external data sources.
 * All signal arrays are empty; the single content opportunity is derived from
 * the tenant's primary motion (or the `inbound_content` fallback).
 *
 * Replace with an LLM-backed implementation in Phase 1 S5.
 */
export const generateDeterministicBrief = (
  request: IntelBriefRequestedV1,
): IntelBriefV1 => {
  const primaryMotion: MotionLabel =
    request.motion_context?.primary_motions[0] ?? DEFAULT_MOTION;

  const opportunityId = crypto.randomUUID();
  const baselineOpportunity: BriefOpportunityRef = {
    opportunity_id: opportunityId,
    title: `Baseline ${primaryMotion.replace(/_/g, " ")} opportunity`,
    rationale:
      "Automatically generated baseline opportunity. Enrich with competitive and community signals once LLM integration is active.",
    urgency: "this_month",
    motion_fit: [primaryMotion],
    score: 0.5,
  };

  const icpContext = request.motion_context?.icp_summary
    ? `ICP context: ${request.motion_context.icp_summary}. `
    : "";

  const brief: IntelBriefV1 = {
    schema_version: "intel_brief.v1",
    tenant_id: request.tenant_id,
    brief_id: crypto.randomUUID(),
    generated_at: new Date().toISOString(),
    period: {
      from: request.period_from,
      to: request.period_to,
    },
    competitive_signals: [],
    community_signals: [],
    content_opportunities: [baselineOpportunity],
    recommended_focus: `${icpContext}Focus on ${primaryMotion.replace(/_/g, " ")} — no external signals processed yet. Run signal collection to enrich this brief.`,
  };

  // Validate the generated brief against the schema before returning.
  return intelBriefV1Schema.parse(brief);
};

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export interface EventPublisher {
  publish(subject: string, payload: Record<string, unknown>): Promise<void>;
}

export interface IntelDirectorWorkerDependencies {
  outboxRepository: OutboxRepository;
  eventPublisher: EventPublisher;
}

export class IntelDirectorWorker {
  constructor(private readonly deps: IntelDirectorWorkerDependencies) {}

  /**
   * Processes an `intel_brief_requested.v1` event.
   *
   * Validates the incoming payload, generates a deterministic brief,
   * persists it to the outbox, and publishes to the tenant NATS subject.
   *
   * @returns The generated IntelBriefV1.
   */
  async processBriefRequest(input: unknown): Promise<IntelBriefV1> {
    const request = intelBriefRequestedV1Schema.parse(input);

    const brief = generateDeterministicBrief(request);

    const command = createIntelBriefOutboxCommand({
      tenantId: request.tenant_id,
      requestId: request.request_id,
      brief,
    });

    await this.deps.outboxRepository.enqueue(command);
    await this.deps.eventPublisher.publish(
      tenantScopedSubject(request.tenant_id, "intel_brief.v1"),
      command.payload,
    );

    return brief;
  }
}
