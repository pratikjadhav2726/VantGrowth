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
