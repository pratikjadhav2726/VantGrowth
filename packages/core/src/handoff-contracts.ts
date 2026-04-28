/**
 * Handoff contracts v0 — agent-to-agent typed payloads.
 *
 * Each contract is:
 *   - Versioned with a literal schema_version discriminant
 *   - Validated with Zod at the boundary (output and input)
 *   - Stored in the Postgres outbox as the `payload` field
 *   - Identified by schema_version for routing decisions
 *
 * Contract chain:
 *   IntelDirector ──produces──► IntelBriefV1
 *                  ──produces──► ContentOpportunityV1 (extracted from brief)
 *   ContentStrategist ──consumes──► ContentOpportunityV1
 *                     ──produces──► ContentBriefV1
 *                     ──produces──► BlogDraftV1 (on demand)
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** YYYY-MM-DD date string */
const dateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

/** RFC-3339 / ISO-8601 datetime string */
const datetimeSchema = z.string().datetime({ offset: true });

/** Urgency levels used across all contracts */
export const urgencySchema = z.enum(["now", "this_week", "this_month"]);
export type Urgency = z.infer<typeof urgencySchema>;

/** Motion type labels (mirrors core motionTypeSchema) */
export const motionLabelSchema = z.enum([
  "inbound_content",
  "community_engagement",
  "outbound_multichannel",
  "lifecycle_expansion",
  "partners",
  "paid",
  "plg",
  "abm",
]);
export type MotionLabel = z.infer<typeof motionLabelSchema>;

// ---------------------------------------------------------------------------
// intel_brief.v1
// ---------------------------------------------------------------------------

export const competitiveSignalSchema = z.object({
  competitor: z.string().min(1),
  signal_type: z.enum([
    "pricing_change",
    "product_launch",
    "positioning_shift",
    "job_posting",
    "content_spike",
  ]),
  summary: z.string().min(1),
  source_url: z.string().url().optional(),
  confidence: z.number().min(0).max(1),
  is_persisting: z.boolean().default(false),
});
export type CompetitiveSignal = z.infer<typeof competitiveSignalSchema>;

export const communitySignalSchema = z.object({
  platform: z.string().min(1),
  signal_type: z.enum([
    "question_spike",
    "pain_point",
    "feature_request",
    "competitor_mention",
    "category_interest",
  ]),
  summary: z.string().min(1),
  sample_posts: z.array(z.string().max(280)).max(3).default([]),
  confidence: z.number().min(0).max(1),
  motion_fit: z.array(motionLabelSchema).default([]),
});
export type CommunitySignal = z.infer<typeof communitySignalSchema>;

export const briefOpportunityRefSchema = z.object({
  opportunity_id: z.string().uuid(),
  title: z.string().min(1),
  rationale: z.string().min(1),
  urgency: urgencySchema,
  motion_fit: z.array(motionLabelSchema),
  score: z.number().min(0).max(2),
});
export type BriefOpportunityRef = z.infer<typeof briefOpportunityRefSchema>;

export const intelBriefV1Schema = z.object({
  schema_version: z.literal("intel_brief.v1"),
  tenant_id: z.string().uuid(),
  brief_id: z.string().uuid(),
  generated_at: datetimeSchema,
  period: z.object({
    from: dateStringSchema,
    to: dateStringSchema,
  }),
  competitive_signals: z.array(competitiveSignalSchema),
  community_signals: z.array(communitySignalSchema),
  content_opportunities: z.array(briefOpportunityRefSchema).min(1),
  recommended_focus: z.string().min(1),
});

export type IntelBriefV1 = z.infer<typeof intelBriefV1Schema>;

// ---------------------------------------------------------------------------
// content_opportunity.v1
// ---------------------------------------------------------------------------

export const opportunityEvidenceSchema = z.object({
  type: z.enum([
    "competitor_move",
    "community_pain",
    "search_trend",
    "customer_feedback",
  ]),
  description: z.string().min(1),
  source_url: z.string().url().optional(),
});
export type OpportunityEvidence = z.infer<typeof opportunityEvidenceSchema>;

export const contentOpportunityV1Schema = z.object({
  schema_version: z.literal("content_opportunity.v1"),
  tenant_id: z.string().uuid(),
  opportunity_id: z.string().uuid(),
  source_brief_id: z.string().uuid(),
  title: z.string().min(1),
  hook: z.string().min(10).describe("1-sentence hook for the content piece"),
  rationale: z.string().min(1),
  target_audience: z.array(z.string().min(1)).min(1),
  motion_fit: z.array(motionLabelSchema).min(1),
  urgency: urgencySchema,
  content_format: z.enum([
    "long_form_blog",
    "short_form_post",
    "video_script",
    "email",
    "case_study",
  ]),
  evidence: z.array(opportunityEvidenceSchema).min(1),
  score: z.number().min(0).max(2),
  created_at: datetimeSchema,
});

export type ContentOpportunityV1 = z.infer<typeof contentOpportunityV1Schema>;

// ---------------------------------------------------------------------------
// content_brief.v1
// ---------------------------------------------------------------------------

export const briefOutlineSectionSchema = z.object({
  section_title: z.string().min(1),
  key_points: z.array(z.string().min(1)).min(1),
  word_count_target: z.number().int().positive().optional(),
});
export type BriefOutlineSection = z.infer<typeof briefOutlineSectionSchema>;

export const internalLinkSuggestionSchema = z.object({
  anchor: z.string().min(1),
  target_url: z.string().min(1),
});

export const contentBriefV1Schema = z.object({
  schema_version: z.literal("content_brief.v1"),
  tenant_id: z.string().uuid(),
  brief_id: z.string().uuid(),
  opportunity_id: z.string().uuid(),
  generated_at: datetimeSchema,
  title: z.string().min(1),
  hook: z.string().min(10),
  target_audience: z.array(z.string().min(1)).min(1),
  search_intent: z.enum([
    "informational",
    "commercial",
    "transactional",
    "navigational",
  ]),
  primary_keyword: z.string().min(1),
  secondary_keywords: z.array(z.string().min(1)).default([]),
  outline: z.array(briefOutlineSectionSchema).min(4),
  tone_notes: z.string().min(1),
  claims_to_avoid: z.array(z.string()).default([]),
  internal_links_suggested: z.array(internalLinkSuggestionSchema).default([]),
  cta: z.string().min(1),
  estimated_word_count: z.number().int().positive(),
  motion_fit: z.array(motionLabelSchema).min(1),
  confidence_score: z.number().min(0).max(1),
});

export type ContentBriefV1 = z.infer<typeof contentBriefV1Schema>;

// ---------------------------------------------------------------------------
// blog_draft.v1
// ---------------------------------------------------------------------------

export const draftClaimSchema = z.object({
  text: z.string().min(1),
  type: z.enum(["stat", "comparison", "prediction", "definition"]),
  requires_verification: z.boolean(),
  source_url: z.string().url().optional(),
});
export type DraftClaim = z.infer<typeof draftClaimSchema>;

export const draftQualityIndicatorsSchema = z.object({
  flesch_score: z.number().min(0).max(100).nullable(),
  grade_level: z.number().nullable(),
  has_cta: z.boolean(),
  has_internal_links: z.boolean(),
  heading_count: z.number().int().nonnegative(),
});

export const blogDraftV1Schema = z.object({
  schema_version: z.literal("blog_draft.v1"),
  tenant_id: z.string().uuid(),
  draft_id: z.string().uuid(),
  brief_id: z.string().uuid(),
  generated_at: datetimeSchema,
  iteration: z.number().int().positive().default(1),
  title: z.string().min(1),
  meta_description: z.string().max(160),
  body_markdown: z.string().min(100),
  word_count: z.number().int().positive(),
  reading_time_minutes: z.number().int().positive(),
  estimated_claims: z.array(draftClaimSchema).default([]),
  quality_indicators: draftQualityIndicatorsSchema,
  status: z
    .enum(["draft", "pending_review", "approved", "rejected"])
    .default("draft"),
});

export type BlogDraftV1 = z.infer<typeof blogDraftV1Schema>;

// ---------------------------------------------------------------------------
// Schema registry — look up a schema by schema_version string.
// Used by routers to validate and dispatch incoming payloads.
// ---------------------------------------------------------------------------

export const HANDOFF_CONTRACT_SCHEMAS = {
  "intel_brief.v1": intelBriefV1Schema,
  "content_opportunity.v1": contentOpportunityV1Schema,
  "content_brief.v1": contentBriefV1Schema,
  "blog_draft.v1": blogDraftV1Schema,
} as const;

export type HandoffContractVersion = keyof typeof HANDOFF_CONTRACT_SCHEMAS;

export const isHandoffContractVersion = (
  v: string,
): v is HandoffContractVersion => v in HANDOFF_CONTRACT_SCHEMAS;

/** Validate any handoff payload by its schema_version discriminant. */
export const parseHandoffContract = (
  payload: unknown,
): IntelBriefV1 | ContentOpportunityV1 | ContentBriefV1 | BlogDraftV1 => {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("schema_version" in payload) ||
    typeof (payload as Record<string, unknown>).schema_version !== "string"
  ) {
    throw new Error("Handoff contract payload missing schema_version field");
  }
  const version = (payload as Record<string, unknown>).schema_version as string;

  if (!isHandoffContractVersion(version)) {
    throw new Error(`Unknown handoff contract version: ${version}`);
  }
  return HANDOFF_CONTRACT_SCHEMAS[version].parse(payload) as
    | IntelBriefV1
    | ContentOpportunityV1
    | ContentBriefV1
    | BlogDraftV1;
};
