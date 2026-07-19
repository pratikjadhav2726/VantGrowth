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
  /** Explicit experiment/canary lineage from the durable request source. */
  experiment_id: z.string().uuid().optional(),
  period_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD"),
  period_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD"),
  requested_by: z.string().min(1).default("system"),
  motion_context: z
    .object({
      primary_motions: z.array(motionLabelSchema).default([]),
      icp_summary: z.string().optional(),
    })
    .optional(),
  /** The durable source signal that requested this brief. */
  trigger: z
    .object({
      signal_id: z.string().min(1),
      signal_type: z.string().min(1).max(100),
      source: z.string().min(1).max(255),
      kind: z.string().min(1).max(255),
      priority: z.enum(["P0", "P1", "P2", "P3"]),
      payload: z.record(z.unknown()),
      occurred_at: z.string().datetime({ offset: true }),
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

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const textValue = (value: unknown, fallback: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) return fallback;
  return value.trim().slice(0, 500);
};

const maybeUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  try {
    return new URL(value).toString();
  } catch {
    return undefined;
  }
};

const sentenceCase = (value: string): string =>
  value
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\w/, (character) => character.toUpperCase());

const triggerSummary = (request: IntelBriefRequestedV1): string | null => {
  if (!request.trigger) return null;
  const payload = asRecord(request.trigger.payload);
  const body = textValue(
    payload.summary ?? payload.text ?? payload.description ?? payload.subject,
    `${sentenceCase(request.trigger.kind)} observed from ${request.trigger.source}.`,
  );
  return `${sentenceCase(request.trigger.kind)} from ${request.trigger.source}: ${body}`;
};

const signalBackedBriefFields = (
  request: IntelBriefRequestedV1,
  primaryMotion: MotionLabel,
): Pick<
  IntelBriefV1,
  | "competitive_signals"
  | "community_signals"
  | "content_opportunities"
  | "recommended_focus"
> => {
  const trigger = request.trigger;
  if (!trigger) {
    const baselineOpportunity: BriefOpportunityRef = {
      opportunity_id: crypto.randomUUID(),
      title: `Baseline ${primaryMotion.replace(/_/g, " ")} opportunity`,
      rationale:
        "No triggering signal was attached. Collect market evidence before promoting this draft.",
      urgency: "this_month",
      motion_fit: [primaryMotion],
      score: 0.5,
    };
    return {
      competitive_signals: [],
      community_signals: [],
      content_opportunities: [baselineOpportunity],
      recommended_focus:
        `Focus on ${primaryMotion.replace(/_/g, " ")} while collecting source-backed market signals.`,
    };
  }

  const payload = asRecord(trigger.payload);
  const summary = triggerSummary(request) ?? "Signal received.";
  const sourceUrl = maybeUrl(payload.source_url ?? payload.sourceUrl);
  const titleSubject = textValue(
    payload.competitor ?? payload.subject ?? payload.topic ?? payload.company,
    sentenceCase(trigger.kind),
  );
  const urgency = trigger.priority === "P0" ? "now" : "this_week";
  const opportunity: BriefOpportunityRef = {
    opportunity_id: crypto.randomUUID(),
    title: `${titleSubject}: a practical response for B2B teams`,
    rationale: summary,
    urgency,
    motion_fit: [primaryMotion],
    score:
      trigger.priority === "P0"
        ? 0.9
        : trigger.priority === "P1"
          ? 0.78
          : 0.65,
  };

  if (trigger.kind.startsWith("competitor.")) {
    const competitor = textValue(payload.competitor, "A market competitor");
    return {
      competitive_signals: [
        {
          competitor,
          signal_type: trigger.kind.includes("pricing")
            ? "pricing_change"
            : trigger.kind.includes("launch")
              ? "product_launch"
              : "positioning_shift",
          summary,
          confidence: trigger.priority === "P0" ? 0.85 : 0.7,
          is_persisting: false,
          ...(sourceUrl ? { source_url: sourceUrl } : {}),
        },
      ],
      community_signals: [],
      content_opportunities: [opportunity],
      recommended_focus: `Respond to the verified ${sentenceCase(trigger.kind)} signal with evidence-backed ${primaryMotion.replace(/_/g, " ")} content.`,
    };
  }

  return {
    competitive_signals: [],
    community_signals: [
      {
        platform: textValue(payload.channel ?? payload.platform, trigger.source),
        signal_type: trigger.kind.includes("competitor")
          ? "competitor_mention"
          : trigger.kind.includes("feature")
            ? "feature_request"
            : trigger.kind.includes("question")
              ? "question_spike"
              : "category_interest",
        summary,
        sample_posts: [textValue(payload.text ?? payload.subject, summary)].slice(
          0,
          3,
        ),
        confidence: trigger.priority === "P0" ? 0.85 : 0.7,
        motion_fit: [primaryMotion],
      },
    ],
    content_opportunities: [opportunity],
    recommended_focus: `Address the observed audience signal through ${primaryMotion.replace(/_/g, " ")} with the source context retained for review.`,
  };
};

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
  const signalFields = signalBackedBriefFields(request, primaryMotion);

  const icpContext = request.motion_context?.icp_summary
    ? `ICP context: ${request.motion_context.icp_summary}. `
    : "";

  const brief: IntelBriefV1 = {
    schema_version: "intel_brief.v1",
    tenant_id: request.tenant_id,
    ...(request.experiment_id
      ? { experiment_id: request.experiment_id }
      : {}),
    brief_id: crypto.randomUUID(),
    generated_at: new Date().toISOString(),
    period: {
      from: request.period_from,
      to: request.period_to,
    },
    competitive_signals: signalFields.competitive_signals,
    community_signals: signalFields.community_signals,
    content_opportunities: signalFields.content_opportunities,
    recommended_focus: `${icpContext}${signalFields.recommended_focus}`,
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
  const signalSummary = triggerSummary(request) ?? "No source signal was attached.";

  let result: Awaited<ReturnType<typeof runner.run>>;
  try {
    result = await runner.run(
      INTEL_BRIEF_GENERATE_STRUCTURED_PROMPT,
      {
        tenantId: request.tenant_id,
        periodFrom: request.period_from,
        periodTo: request.period_to,
        motionContext,
        signalSummary,
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
    const safeRaw =
      typeof raw === "object" && raw !== null
        ? (() => {
            const { experiment_id: _untrustedExperimentId, ...rest } = raw as Record<
              string,
              unknown
            >;
            return rest;
          })()
        : raw;
    // Inject canonical fields that the LLM may have templated with placeholders.
    const augmented =
      typeof safeRaw === "object" && safeRaw !== null
        ? {
            ...safeRaw,
            tenant_id: request.tenant_id,
            ...(request.experiment_id
              ? { experiment_id: request.experiment_id }
              : {}),
            generated_at:
              (safeRaw as Record<string, unknown>).generated_at ??
              new Date().toISOString(),
          }
        : safeRaw;
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
  /**
   * Retained for source compatibility. Production delivery is delegated to
   * the outbox publisher so a crash cannot create a direct-publish-only side
   * effect or duplicate downstream work.
   */
  eventPublisher?: EventPublisher;
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

    return { ...brief, _llmGenerated: llmGenerated };
  }
}
