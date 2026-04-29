/**
 * PromptTemplate — versioned, typed prompt contracts.
 *
 * Every prompt that enters an LLM call must be registered as a PromptTemplate.
 * This enforces:
 *   - Version tracking: every prompt has a semver version string so that
 *     LlmCallLog rows can be attributed to a specific prompt revision.
 *   - Type safety: variable substitution is typed via the generic TVars param.
 *   - Testability: templates are pure functions — no side effects, fully
 *     deterministic given the same vars.
 *
 * Usage:
 *   const myPrompt = definePrompt<{ topic: string }>({
 *     id: "intel-brief.generate",
 *     version: "1.0.0",
 *     system: "You are a B2B growth strategist.",
 *     render: (vars) => `Generate an intel brief about ${vars.topic}.`,
 *   });
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromptTemplate<
  TVars extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Dot-namespaced identifier, e.g. "intel-brief.generate" */
  readonly id: string;
  /** Semver version string for prompt versioning and log attribution */
  readonly version: string;
  /** Optional system prompt. When absent the runner uses its own default. */
  readonly system?: string;
  /** Renders the user message given variable substitutions. */
  render(vars: TVars): string;
}

export const promptTemplateMetaSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[\w.-]+$/, "id must be dot-namespaced word chars"),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/, "version must be semver (X.Y.Z)"),
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Defines a typed PromptTemplate.  The factory validates id and version format
 * at construction time so misconfigured templates fail fast at startup.
 */
export const definePrompt = <
  TVars extends Record<string, unknown> = Record<string, unknown>,
>(
  config: PromptTemplate<TVars>,
): PromptTemplate<TVars> => {
  promptTemplateMetaSchema.parse({ id: config.id, version: config.version });
  return config;
};

// ---------------------------------------------------------------------------
// Built-in GrowthOS prompt templates (stubs — replace body in Phase 2 LLM pass)
// ---------------------------------------------------------------------------

export const INTEL_BRIEF_GENERATE_PROMPT = definePrompt<{
  tenantId: string;
  periodFrom: string;
  periodTo: string;
  motionContext: string;
}>({
  id: "intel-brief.generate",
  version: "1.0.0",
  system:
    "You are a B2B growth strategist specialising in founder-led GTM. " +
    "You produce concise, evidence-backed intelligence briefs that help founders " +
    "prioritise their content and outreach motion for the coming week.",
  render: ({ periodFrom, periodTo, motionContext }) =>
    `Generate an intelligence brief covering the period ${periodFrom} to ${periodTo}. Motion context: ${motionContext}. Include competitive signals, community signals, and 2–3 prioritised content opportunities.`,
});

export const CONTENT_BRIEF_GENERATE_PROMPT = definePrompt<{
  opportunityTitle: string;
  motionFit: string;
  hook: string;
  targetAudience: string;
}>({
  id: "content-brief.generate",
  version: "1.0.0",
  system:
    "You are a senior B2B content strategist. " +
    "You write structured content briefs that guide writers to produce " +
    "high-converting, founder-voice articles.",
  render: ({ opportunityTitle, motionFit, hook, targetAudience }) =>
    `Write a detailed content brief for the opportunity: "${opportunityTitle}". Motion fit: ${motionFit}. Hook: "${hook}". Target audience: ${targetAudience}. Include title, outline (5+ sections with key points), primary keyword, tone notes, and a specific CTA.`,
});

export const BLOG_DRAFT_GENERATE_PROMPT = definePrompt<{
  title: string;
  hook: string;
  outline: string;
  toneNotes: string;
  primaryKeyword: string;
}>({
  id: "blog-draft.generate",
  version: "1.0.0",
  system:
    "You are an expert B2B content writer specialising in founder-voice articles. " +
    "You write in a direct, evidence-backed style. Never use corporate buzzwords.",
  render: ({ title, hook, outline, toneNotes, primaryKeyword }) =>
    `Write a full blog post for: "${title}". Opening hook: "${hook}". Outline: ${outline}. Tone: ${toneNotes}. Primary keyword: "${primaryKeyword}". Target 1400 words. Include at least one statistic or proof point. End with a CTA.`,
});

/**
 * CONTENT_BRIEF_GENERATE_STRUCTURED_PROMPT
 *
 * JSON-output version of the content brief generator, used by the
 * LLM-backed ContentStrategistWorker.  Returns a ContentBriefV1-shaped
 * JSON object that is validated before use.
 */
export const CONTENT_BRIEF_GENERATE_STRUCTURED_PROMPT = definePrompt<{
  opportunityTitle: string;
  motionFit: string;
  hook: string;
  targetAudience: string;
  tenantId: string;
  opportunityId: string;
}>({
  id: "content-brief.generate-structured",
  version: "1.0.0",
  system:
    "You are a senior B2B content strategist. " +
    "Return ONLY valid JSON — no markdown fences, no commentary. " +
    "The JSON must conform to the ContentBriefV1 schema.",
  render: ({
    opportunityTitle,
    motionFit,
    hook,
    targetAudience,
    tenantId,
    opportunityId,
  }) =>
    `Generate a structured content brief for the opportunity: "${opportunityTitle}".
Motion fit: ${motionFit}. Hook: "${hook}". Target audience: ${targetAudience}.

Respond with a JSON object matching this exact shape:
{
  "schema_version": "content_brief.v1",
  "tenant_id": "${tenantId}",
  "brief_id": "<uuid>",
  "opportunity_id": "${opportunityId}",
  "generated_at": "<ISO 8601>",
  "title": "<string>",
  "hook": "<string>",
  "target_audience": ["<string>"],
  "search_intent": "informational | navigational | transactional | commercial",
  "primary_keyword": "<string>",
  "secondary_keywords": ["<string>"],
  "outline": [
    {
      "section_title": "<string>",
      "key_points": ["<string>"],
      "word_count_target": 300
    }
  ],
  "tone_notes": "<string>",
  "claims_to_avoid": ["<string>"],
  "internal_links_suggested": [],
  "cta": "<string>",
  "estimated_word_count": 1400,
  "motion_fit": ["${motionFit}"],
  "confidence_score": 0.8
}`,
});

/**
 * INTEL_BRIEF_GENERATE_STRUCTURED_PROMPT
 *
 * Upgraded version of the intel brief generator that asks the LLM to produce
 * a structured JSON payload conforming to IntelBriefV1.  The caller is
 * responsible for parsing and validating the JSON; on failure it falls back to
 * the deterministic generator.
 */
export const INTEL_BRIEF_GENERATE_STRUCTURED_PROMPT = definePrompt<{
  tenantId: string;
  periodFrom: string;
  periodTo: string;
  motionContext: string;
  signalSummary: string;
}>({
  id: "intel-brief.generate-structured",
  version: "1.0.0",
  system:
    "You are a B2B growth strategist specialising in founder-led GTM. " +
    "Return ONLY valid JSON — no markdown fences, no commentary. " +
    "The JSON must conform to the IntelBriefV1 schema.",
  render: ({ tenantId, periodFrom, periodTo, motionContext, signalSummary }) =>
    `Generate an intel brief for tenant ${tenantId} covering ${periodFrom} to ${periodTo}.
Motion context: ${motionContext}.
Signal summary: ${signalSummary || "No signals ingested yet — generate baseline opportunities."}

Respond with a JSON object matching this exact shape (all fields required):
{
  "schema_version": "intel_brief.v1",
  "tenant_id": "<tenantId>",
  "brief_id": "<uuid>",
  "generated_at": "<ISO 8601>",
  "period": { "from": "<YYYY-MM-DD>", "to": "<YYYY-MM-DD>" },
  "competitive_signals": [],
  "community_signals": [],
  "content_opportunities": [
    {
      "opportunity_id": "<uuid>",
      "title": "<string>",
      "rationale": "<string>",
      "urgency": "this_week | this_month | next_quarter",
      "motion_fit": ["<motion_label>"],
      "score": 0.0
    }
  ],
  "recommended_focus": "<string>"
}`,
});

/**
 * SIGNAL_GRADE_PROMPT
 *
 * Grades a single raw signal event, extracting structured quality metadata:
 * relevance score, urgency, categorised topic, and action recommendations.
 * Used by the signal routing pipeline before writing to signal_events.
 */
export const SIGNAL_GRADE_PROMPT = definePrompt<{
  signalType: string;
  source: string;
  rawPayload: string;
  motionContext: string;
}>({
  id: "signal.grade",
  version: "1.0.0",
  system:
    "You are a B2B GTM intelligence analyst. " +
    "Grade the relevance and urgency of a raw signal for a founder-led GTM motion. " +
    "Return ONLY valid JSON — no markdown fences.",
  render: ({ signalType, source, rawPayload, motionContext }) =>
    `Grade this ${signalType} signal from "${source}" for a founder with motion context: ${motionContext}.

Signal payload:
${rawPayload}

Respond with JSON:
{
  "relevance": 0.0,
  "urgency": "low | medium | high",
  "topic_category": "<short label>",
  "action_recommendations": ["<string>"]
}`,
});

export const CRITIQUE_EVALUATE_PROMPT = definePrompt<{
  artifactKind: string;
  candidateOutput: string;
  rubricCriteria: string;
}>({
  id: "critique.evaluate",
  version: "1.0.0",
  system:
    "You are a rigorous content quality evaluator. " +
    "Evaluate the candidate output against the provided rubric criteria. " +
    "Be specific about failures.",
  render: ({ artifactKind, candidateOutput, rubricCriteria }) =>
    `Evaluate this ${artifactKind} against the rubric:\n\nRubric: ${rubricCriteria}\n\nCandidate:\n${candidateOutput}\n\nRespond with: verdict (approve/revise/reject), confidence_score (0-1), and reasons array.`,
});

/**
 * RUBRIC_CRITERION_EVALUATE_PROMPT
 *
 * Evaluates a single rubric criterion against a candidate text.  Used for
 * custom/unknown checks that cannot be evaluated deterministically.  The caller
 * is responsible for parsing the JSON response and falling back gracefully on
 * failure.
 */
export const RUBRIC_CRITERION_EVALUATE_PROMPT = definePrompt<{
  criterionId: string;
  criterionDescription: string;
  candidateText: string;
}>({
  id: "rubric.criterion.evaluate",
  version: "1.0.0",
  system:
    "You are a content quality auditor. " +
    "Determine whether the provided text satisfies a specific rubric criterion. " +
    "Return ONLY valid JSON — no markdown fences, no commentary.",
  render: ({ criterionId, criterionDescription, candidateText }) =>
    `Does the following text satisfy this criterion?

Criterion ID: ${criterionId}
Criterion: ${criterionDescription}

Text (first 3000 chars):
${candidateText.slice(0, 3000)}

Respond with JSON:
{
  "passed": true or false,
  "confidence": 0.0 to 1.0,
  "explanation": "<one sentence>"
}`,
});
