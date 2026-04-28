/**
 * IntelDirectorWorker — Phase 1 / S3 → S5
 *
 * Processes `intel_brief_requested.v1` events, generates a structured
 * IntelBriefV1 payload, and emits it via the Postgres outbox + NATS.
 *
 * ## Brief generation strategy (two-tier)
 *
 * 1. **LLM path** (preferred): when a `LlmCallRunner` is injected, the worker
 *    calls `INTEL_BRIEF_GENERATE_STRUCTURED_PROMPT` and attempts to parse the
 *    JSON response into a schema-valid `IntelBriefV1`.  If parsing succeeds the
 *    result is used directly.
 *
 * 2. **Deterministic fallback**: when no runner is injected, or when the LLM
 *    returns invalid / unparseable JSON, `generateDeterministicBrief()` is used.
 *    This ensures the pipeline never stalls waiting for an LLM.
 *
 * ## Idempotency
 *
 * The outbox UNIQUE(tenant_id, event_type, idempotency_key) constraint silently
 * discards a re-delivered brief for the same request_id.
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
import {
  INTEL_BRIEF_GENERATE_STRUCTURED_PROMPT,
  type LlmCallRunner,
} from "@growthos/llm-harness";
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
// Deterministic brief generator (fallback)
// ---------------------------------------------------------------------------

const DEFAULT_MOTION: MotionLabel = "inbound_content";

/**
 * Generates a structurally-valid IntelBriefV1 without external data sources.
 * Used when: (a) no LlmCallRunner is configured, or (b) the LLM returns
 * unparseable / invalid JSON.
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

  return intelBriefV1Schema.parse(brief);
};

// ---------------------------------------------------------------------------
// LLM brief generator
// ---------------------------------------------------------------------------

/**
 * Attempts to generate an `IntelBriefV1` via the LLM runner.
 *
 * The LLM is asked to return a JSON-only response.  We extract the first
 * JSON object from the response (to handle any stray whitespace) and validate
 * it against `intelBriefV1Schema`.
 *
 * Returns `null` when:
 *   - The LLM response contains no parseable JSON.
 *   - The parsed JSON fails `intelBriefV1Schema` validation.
 * The caller falls back to `generateDeterministicBrief()` in both cases.
 */
export const generateLlmBrief = async (
  request: IntelBriefRequestedV1,
  runner: LlmCallRunner,
): Promise<IntelBriefV1 | null> => {
  const motionContext = request.motion_context
    ? [
        `Primary motions: ${request.motion_context.primary_motions.join(", ") || "none"}`,
        request.motion_context.icp_summary
          ? `ICP: ${request.motion_context.icp_summary}`
          : null,
      ]
        .filter(Boolean)
        .join(". ")
    : "No motion context provided.";

  let result: Awaited<ReturnType<typeof runner.run>>;
  try {
    result = await runner.run(
      INTEL_BRIEF_GENERATE_STRUCTURED_PROMPT,
      {
        tenantId: request.tenant_id,
        periodFrom: request.period_from,
        periodTo: request.period_to,
        motionContext,
        signalSummary: "",
      },
      { tenantId: request.tenant_id },
    );
  } catch {
    return null;
  }

  // Extract JSON from the response content (may have stray whitespace/newlines).
  const jsonMatch = result.content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const raw = JSON.parse(jsonMatch[0]) as unknown;
    // Inject canonical fields that the LLM may have templated with placeholders.
    const augmented =
      typeof raw === "object" && raw !== null
        ? {
            ...raw,
            tenant_id: request.tenant_id,
            generated_at:
              (raw as Record<string, unknown>).generated_at ??
              new Date().toISOString(),
          }
        : raw;
    return intelBriefV1Schema.parse(augmented);
  } catch {
    return null;
  }
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
  /**
   * Optional LLM runner.  When provided, `processBriefRequest()` attempts to
   * generate the brief via LLM before falling back to the deterministic stub.
   * Inject `StubLlmCallRunner` in tests; `OpenAiLlmCallRunner.fromEnv()` in
   * production.
   */
  llmCallRunner?: LlmCallRunner;
}

export class IntelDirectorWorker {
  constructor(private readonly deps: IntelDirectorWorkerDependencies) {}

  /**
   * Processes an `intel_brief_requested.v1` event.
   *
   * Generation order:
   *   1. If `llmCallRunner` is configured → try `generateLlmBrief()`.
   *   2. If LLM returns null (parse error / no runner) → `generateDeterministicBrief()`.
   *
   * @returns The generated IntelBriefV1 and whether it was LLM-generated.
   */
  async processBriefRequest(
    input: unknown,
  ): Promise<IntelBriefV1 & { _llmGenerated?: boolean }> {
    const request = intelBriefRequestedV1Schema.parse(input);

    let brief: IntelBriefV1;
    let llmGenerated = false;

    if (this.deps.llmCallRunner) {
      const llmBrief = await generateLlmBrief(request, this.deps.llmCallRunner);
      if (llmBrief) {
        brief = llmBrief;
        llmGenerated = true;
      } else {
        brief = generateDeterministicBrief(request);
      }
    } else {
      brief = generateDeterministicBrief(request);
    }

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

    return { ...brief, _llmGenerated: llmGenerated };
  }
}
