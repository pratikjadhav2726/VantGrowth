/**
 * ContentStrategistWorker — Phase 1 / S3
 *
 * Consumes IntelBriefV1 payloads (published by IntelDirectorWorker on
 * `t.{tenantId}.intel_brief.v1`) and produces two downstream artefacts for
 * every content opportunity in the brief:
 *
 *   1. ContentOpportunityV1 — expands the brief's compact `BriefOpportunityRef`
 *      into a full, evidence-backed opportunity record.
 *
 *   2. ContentBriefV1 — a structured writing brief: outline, keywords,
 *      tone notes, CTA, word-count target, and confidence score.
 *
 * Phase 1 design: all generation is deterministic (no LLM).  Replace
 * `expandOpportunity()` and `generateContentBrief()` with LLM-backed variants
 * in Phase 1 S5 without touching the outbox contract or NATS subjects.
 *
 * Idempotency: both artefacts are keyed by `${brief_id}:${opportunity_id}` so
 * a re-delivered `intel_brief.v1` message produces the same idempotency keys
 * and the outbox UNIQUE constraint silently drops the duplicates.
 */

import {
  type BriefOpportunityRef,
  type ContentBriefV1,
  type ContentOpportunityV1,
  type IntelBriefV1,
  type MotionLabel,
  contentBriefV1Schema,
  contentOpportunityV1Schema,
  intelBriefV1Schema,
} from "@growthos/core";
import type { OutboxRepository } from "@growthos/db";
import { tenantScopedSubject } from "@growthos/db";

// ---------------------------------------------------------------------------
// Deterministic generators
// ---------------------------------------------------------------------------

/**
 * Expands a compact BriefOpportunityRef into a full ContentOpportunityV1.
 * All free-text fields are derived from the available structured data.
 */
export const expandOpportunity = (
  brief: IntelBriefV1,
  ref: BriefOpportunityRef,
): ContentOpportunityV1 => {
  const primaryMotion: MotionLabel = ref.motion_fit[0] ?? "inbound_content";
  const formatByMotion: Record<
    MotionLabel,
    ContentOpportunityV1["content_format"]
  > = {
    inbound_content: "long_form_blog",
    community_engagement: "short_form_post",
    outbound_multichannel: "email",
    lifecycle_expansion: "case_study",
    partners: "long_form_blog",
    paid: "short_form_post",
    plg: "long_form_blog",
    abm: "case_study",
  };

  const opportunity: ContentOpportunityV1 = {
    schema_version: "content_opportunity.v1",
    tenant_id: brief.tenant_id,
    opportunity_id: ref.opportunity_id,
    source_brief_id: brief.brief_id,
    title: ref.title,
    hook: `Learn why ${ref.title.toLowerCase()} matters for your ${primaryMotion.replace(/_/g, " ")} strategy.`,
    rationale: ref.rationale,
    target_audience: ["B2B founders", "growth practitioners"],
    motion_fit:
      ref.motion_fit.length > 0 ? ref.motion_fit : ["inbound_content"],
    urgency: ref.urgency,
    content_format: formatByMotion[primaryMotion] ?? "long_form_blog",
    evidence: [
      {
        type: "search_trend",
        description:
          "Baseline evidence placeholder — populate with competitive + community signal data once LLM integration is active.",
      },
    ],
    score: ref.score,
    created_at: new Date().toISOString(),
  };

  return contentOpportunityV1Schema.parse(opportunity);
};

/**
 * Generates a ContentBriefV1 from an expanded ContentOpportunityV1.
 * Produces a 5-section outline that is structurally valid and LLM-ready.
 */
export const generateContentBrief = (
  opportunity: ContentOpportunityV1,
): ContentBriefV1 => {
  const motionLabel = opportunity.motion_fit[0] ?? "inbound_content";
  const titleSlug = opportunity.title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join("-");

  const brief: ContentBriefV1 = {
    schema_version: "content_brief.v1",
    tenant_id: opportunity.tenant_id,
    brief_id: crypto.randomUUID(),
    opportunity_id: opportunity.opportunity_id,
    generated_at: new Date().toISOString(),
    title: opportunity.title,
    hook: opportunity.hook,
    target_audience: opportunity.target_audience,
    search_intent: "informational",
    primary_keyword: titleSlug,
    secondary_keywords: [motionLabel.replace(/_/g, " "), "growth strategy"],
    outline: [
      {
        section_title: "Introduction & Context",
        key_points: [
          `Why ${opportunity.title} is relevant now`,
          "The cost of ignoring this opportunity",
        ],
        word_count_target: 200,
      },
      {
        section_title: "Core Framework",
        key_points: [
          "Define the key concept in one sentence",
          `How it maps to ${motionLabel.replace(/_/g, " ")} motion`,
          "Step-by-step approach",
        ],
        word_count_target: 400,
      },
      {
        section_title: "Evidence & Examples",
        key_points: [
          "Data point or case study (populate from signal store)",
          "Counter-intuitive insight",
          "Quote or validation from community signal",
        ],
        word_count_target: 350,
      },
      {
        section_title: "Implementation Guide",
        key_points: [
          "Immediate action (this week)",
          "Medium-term initiative (this month)",
          "Success metric to track",
        ],
        word_count_target: 300,
      },
      {
        section_title: "Conclusion & CTA",
        key_points: [
          "Restate the core insight in one line",
          "Invite reader engagement",
        ],
        word_count_target: 150,
      },
    ],
    tone_notes: `Founder-voice. First person preferred. Practical over theoretical. ${
      motionLabel === "plg" ? "Show product screenshots where relevant." : ""
    } Avoid superlatives and unverified stats.`,
    claims_to_avoid: [
      "market leader",
      "industry-leading",
      "best-in-class",
      "10x results",
    ],
    internal_links_suggested: [],
    cta: `Start your ${motionLabel.replace(/_/g, " ")} motion — book a strategy session.`,
    estimated_word_count: 1400,
    motion_fit: opportunity.motion_fit,
    confidence_score: Math.min(opportunity.score / 2, 1),
  };

  return contentBriefV1Schema.parse(brief);
};

// ---------------------------------------------------------------------------
// Outbox command builders
// ---------------------------------------------------------------------------

export const createContentOpportunityOutboxCommand = (
  opportunity: ContentOpportunityV1,
  briefId: string,
) => ({
  tenantId: opportunity.tenant_id,
  eventType: "content_opportunity.v1",
  idempotencyKey: `content-opportunity:${briefId}:${opportunity.opportunity_id}`,
  payload: opportunity as unknown as Record<string, unknown>,
});

export const createContentBriefOutboxCommand = (
  brief: ContentBriefV1,
  intelBriefId: string,
) => ({
  tenantId: brief.tenant_id,
  eventType: "content_brief.v1",
  idempotencyKey: `content-brief:${intelBriefId}:${brief.opportunity_id}`,
  payload: brief as unknown as Record<string, unknown>,
});

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export interface EventPublisher {
  publish(subject: string, payload: Record<string, unknown>): Promise<void>;
}

export interface ContentStrategistWorkerDependencies {
  outboxRepository: OutboxRepository;
  eventPublisher: EventPublisher;
}

export interface ProcessBriefResult {
  opportunities: ContentOpportunityV1[];
  briefs: ContentBriefV1[];
}

export class ContentStrategistWorker {
  constructor(private readonly deps: ContentStrategistWorkerDependencies) {}

  /**
   * Processes an `intel_brief.v1` event, generating and emitting a
   * ContentOpportunityV1 + ContentBriefV1 pair for every opportunity
   * in the brief.
   *
   * @returns The generated artefacts (useful in tests and for upstream metrics).
   */
  async processBrief(input: unknown): Promise<ProcessBriefResult> {
    const brief = intelBriefV1Schema.parse(input);
    const opportunities: ContentOpportunityV1[] = [];
    const briefs: ContentBriefV1[] = [];

    for (const ref of brief.content_opportunities) {
      const opportunity = expandOpportunity(brief, ref);
      const contentBrief = generateContentBrief(opportunity);

      // Persist artefacts to outbox (durable, idempotent)
      const oppCommand = createContentOpportunityOutboxCommand(
        opportunity,
        brief.brief_id,
      );
      const briefCommand = createContentBriefOutboxCommand(
        contentBrief,
        brief.brief_id,
      );

      await this.deps.outboxRepository.enqueue(oppCommand);
      await this.deps.outboxRepository.enqueue(briefCommand);

      // Publish immediately for live consumers
      await this.deps.eventPublisher.publish(
        tenantScopedSubject(brief.tenant_id, "content_opportunity.v1"),
        oppCommand.payload,
      );
      await this.deps.eventPublisher.publish(
        tenantScopedSubject(brief.tenant_id, "content_brief.v1"),
        briefCommand.payload,
      );

      opportunities.push(opportunity);
      briefs.push(contentBrief);
    }

    return { opportunities, briefs };
  }
}
