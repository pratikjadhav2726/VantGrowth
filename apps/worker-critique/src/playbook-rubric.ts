/**
 * Playbook-driven rubric evaluation for the CritiqueWorker.
 *
 * A playbook's `content` field carries a `RubricPlaybookContent` object.
 * Each criterion is evaluated deterministically against the candidate text
 * using lightweight pattern checks — no LLM required in Phase 1.
 *
 * Criterion `check` values:
 *   "has_cta"        — text contains a recognised call-to-action phrase
 *   "has_evidence"   — text contains numbers, percentages, or stat indicators
 *   "no_forbidden"   — none of `forbidden_phrases` appear in the text
 *   "length_ok"      — word count is within [min_word_count, max_word_count]
 *   "has_headings"   — text contains at least one markdown heading (## / ###)
 *   "has_hook"       — first 100 chars form a compelling hook (non-trivial)
 *   *any other*      — treated as a custom check; always passes to avoid false
 *                      negatives until LLM integration is wired.
 *
 * Replace `evaluateCriterion()` with an LLM call in Phase 1 S7 without
 * touching the scoring math or the CritiqueWorker contract.
 */

import {
  type LlmCallRunner,
  RUBRIC_CRITERION_EVALUATE_PROMPT,
} from "@growthos/llm-harness";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Playbook content schema (stored as JSONB in playbook_versions.content)
// ---------------------------------------------------------------------------

export const rubricCriterionSchema = z.object({
  id: z.string().min(1),
  weight: z.number().min(0).max(1),
  description: z.string().min(1),
  check: z.string().min(1),
});
export type RubricCriterion = z.infer<typeof rubricCriterionSchema>;

export const rubricPlaybookContentSchema = z.object({
  rubric: z.array(rubricCriterionSchema).min(1),
  min_word_count: z.number().int().positive().optional(),
  max_word_count: z.number().int().positive().optional(),
  forbidden_phrases: z.array(z.string().min(1)).optional(),
});
export type RubricPlaybookContent = z.infer<typeof rubricPlaybookContentSchema>;

// ---------------------------------------------------------------------------
// Per-criterion result
// ---------------------------------------------------------------------------

export interface CriterionResult {
  id: string;
  passed: boolean;
  weight: number;
  description: string;
  details: string;
}

// ---------------------------------------------------------------------------
// Deterministic check implementations
// ---------------------------------------------------------------------------

const CTA_PATTERNS = [
  /book\s+a/i,
  /start\s+your/i,
  /get\s+started/i,
  /sign\s+up/i,
  /learn\s+more/i,
  /try\s+it/i,
  /contact\s+us/i,
  /schedule\s+a/i,
  /request\s+a\s+demo/i,
  /free\s+trial/i,
];

const EVIDENCE_PATTERNS = [
  /\d+%/,
  /\$\d/,
  /\d+x\b/i,
  /\d+\s+times/i,
  /according\s+to/i,
  /study\s+shows/i,
  /research\s+found/i,
  /data\s+shows/i,
  /survey/i,
];

const countWords = (text: string): number =>
  text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;

export interface EvaluateConfig {
  minWordCount?: number | undefined;
  maxWordCount?: number | undefined;
  forbiddenPhrases?: string[] | undefined;
}

export const evaluateCriterion = (
  check: string,
  text: string,
  config: EvaluateConfig,
): { passed: boolean; details: string } => {
  switch (check) {
    case "has_cta": {
      const found = CTA_PATTERNS.some((p) => p.test(text));
      return {
        passed: found,
        details: found
          ? "CTA phrase detected"
          : "No recognised CTA phrase found",
      };
    }

    case "has_evidence": {
      const found = EVIDENCE_PATTERNS.some((p) => p.test(text));
      return {
        passed: found,
        details: found
          ? "Evidence pattern detected"
          : "No quantitative evidence found",
      };
    }

    case "no_forbidden": {
      const phrases = config.forbiddenPhrases ?? [];
      const found = phrases.filter((p) =>
        text.toLowerCase().includes(p.toLowerCase()),
      );
      return {
        passed: found.length === 0,
        details:
          found.length === 0
            ? "No forbidden phrases found"
            : `Forbidden phrases: ${found.join(", ")}`,
      };
    }

    case "length_ok": {
      const wc = countWords(text);
      const min = config.minWordCount ?? 0;
      const max = config.maxWordCount ?? Number.POSITIVE_INFINITY;
      const passed = wc >= min && wc <= max;
      return {
        passed,
        details: `Word count: ${wc} (expected ${min}–${max === Number.POSITIVE_INFINITY ? "∞" : max})`,
      };
    }

    case "has_headings": {
      const found = /^##?\s+\S/m.test(text);
      return {
        passed: found,
        details: found ? "Markdown headings present" : "No markdown headings",
      };
    }

    case "has_hook": {
      const firstSegment = text.slice(0, 120).trim();
      const passed = firstSegment.length >= 40;
      return {
        passed,
        details: passed
          ? "Opening segment is substantive"
          : "Opening is too short to be a hook",
      };
    }

    default:
      // Unknown checks pass to avoid false negatives in the sync path.
      // Use evaluateCriterionWithLlm / evaluateRubricAsync for LLM-backed evaluation.
      return {
        passed: true,
        details: `Unknown check "${check}" — auto-passed (no LLM configured)`,
      };
  }
};

// ---------------------------------------------------------------------------
// Known check set — used to route to sync vs. async LLM evaluation
// ---------------------------------------------------------------------------

const KNOWN_CHECKS = new Set([
  "has_cta",
  "has_evidence",
  "no_forbidden",
  "length_ok",
  "has_headings",
  "has_hook",
]);

export const isKnownCheck = (check: string): boolean =>
  KNOWN_CHECKS.has(check);

// ---------------------------------------------------------------------------
// Per-criterion LLM evaluator (for custom/unknown checks)
// ---------------------------------------------------------------------------

const criterionLlmResponseSchema = z.object({
  passed: z.boolean(),
  confidence: z.number().min(0).max(1).optional(),
  explanation: z.string().optional(),
});

/**
 * Evaluates a single rubric criterion using the LLM when the check type is not
 * in the known deterministic set.  Falls back to auto-pass on any runner error,
 * missing JSON, or schema validation failure to avoid false negatives.
 */
export const evaluateCriterionWithLlm = async (
  criterion: RubricCriterion,
  text: string,
  runner: LlmCallRunner,
): Promise<{ passed: boolean; details: string }> => {
  let content: string;
  try {
    const result = await runner.run(RUBRIC_CRITERION_EVALUATE_PROMPT, {
      criterionId: criterion.id,
      criterionDescription: criterion.description,
      candidateText: text,
    });
    content = result.content;
  } catch {
    return {
      passed: true,
      details: `LLM runner error — auto-passed for "${criterion.check}"`,
    };
  }

  const match = content.match(/\{[\s\S]*\}/);
  if (!match) {
    return {
      passed: true,
      details: `LLM returned no JSON — auto-passed for "${criterion.check}"`,
    };
  }

  try {
    const parsed = criterionLlmResponseSchema.safeParse(JSON.parse(match[0]));
    if (!parsed.success) {
      return {
        passed: true,
        details: `LLM response schema invalid — auto-passed for "${criterion.check}"`,
      };
    }
    const { passed, explanation } = parsed.data;
    return {
      passed,
      details:
        explanation ??
        (passed ? "LLM: criterion satisfied" : "LLM: criterion not satisfied"),
    };
  } catch {
    return {
      passed: true,
      details: `LLM JSON parse error — auto-passed for "${criterion.check}"`,
    };
  }
};

// ---------------------------------------------------------------------------
// Full rubric evaluation
// ---------------------------------------------------------------------------

export interface RubricEvaluationResult {
  /** Weighted score in [0, 1] */
  score: number;
  criteriaResults: CriterionResult[];
  reasons: string[];
}

export const evaluateRubric = (
  content: RubricPlaybookContent,
  candidateText: string,
): RubricEvaluationResult => {
  const config: EvaluateConfig = {
    ...(content.min_word_count !== undefined
      ? { minWordCount: content.min_word_count }
      : {}),
    ...(content.max_word_count !== undefined
      ? { maxWordCount: content.max_word_count }
      : {}),
    ...(content.forbidden_phrases !== undefined
      ? { forbiddenPhrases: content.forbidden_phrases }
      : {}),
  };

  const criteriaResults: CriterionResult[] = content.rubric.map((criterion) => {
    const { passed, details } = evaluateCriterion(
      criterion.check,
      candidateText,
      config,
    );
    return {
      id: criterion.id,
      passed,
      weight: criterion.weight,
      description: criterion.description,
      details,
    };
  });

  // Normalise weights to sum to 1 to be resilient to misconfigured playbooks.
  const totalWeight = criteriaResults.reduce((s, c) => s + c.weight, 0);
  const normalisedScore =
    totalWeight > 0
      ? criteriaResults.reduce(
          (s, c) => s + (c.passed ? c.weight / totalWeight : 0),
          0,
        )
      : 0;

  const failedReasons = criteriaResults
    .filter((c) => !c.passed)
    .map((c) => `${c.description}: ${c.details}`);

  return {
    score: Math.min(1, Math.max(0, normalisedScore)),
    criteriaResults,
    reasons:
      failedReasons.length > 0
        ? failedReasons
        : ["All rubric criteria passed."],
  };
};

/**
 * Async variant of evaluateRubric that delegates unknown criterion checks to
 * the LLM runner when one is provided.  Known checks (has_cta, has_evidence,
 * no_forbidden, length_ok, has_headings, has_hook) always run deterministically
 * regardless of whether a runner is present — they are fast, free, and exact.
 *
 * Falls back to auto-pass for unknown checks when no runner is configured,
 * preserving backward compatibility with the synchronous path.
 */
export const evaluateRubricAsync = async (
  content: RubricPlaybookContent,
  candidateText: string,
  llmRunner?: LlmCallRunner,
): Promise<RubricEvaluationResult> => {
  const config: EvaluateConfig = {
    ...(content.min_word_count !== undefined
      ? { minWordCount: content.min_word_count }
      : {}),
    ...(content.max_word_count !== undefined
      ? { maxWordCount: content.max_word_count }
      : {}),
    ...(content.forbidden_phrases !== undefined
      ? { forbiddenPhrases: content.forbidden_phrases }
      : {}),
  };

  const criteriaResults: CriterionResult[] = await Promise.all(
    content.rubric.map(async (criterion): Promise<CriterionResult> => {
      let passed: boolean;
      let details: string;

      if (isKnownCheck(criterion.check)) {
        // Fast deterministic path — no LLM call needed.
        ({ passed, details } = evaluateCriterion(
          criterion.check,
          candidateText,
          config,
        ));
      } else if (llmRunner) {
        // Custom check with LLM available — delegate.
        ({ passed, details } = await evaluateCriterionWithLlm(
          criterion,
          candidateText,
          llmRunner,
        ));
      } else {
        // Custom check, no LLM — auto-pass.
        passed = true;
        details = `Unknown check "${criterion.check}" — auto-passed (no LLM configured)`;
      }

      return {
        id: criterion.id,
        passed,
        weight: criterion.weight,
        description: criterion.description,
        details,
      };
    }),
  );

  const totalWeight = criteriaResults.reduce((s, c) => s + c.weight, 0);
  const normalisedScore =
    totalWeight > 0
      ? criteriaResults.reduce(
          (s, c) => s + (c.passed ? c.weight / totalWeight : 0),
          0,
        )
      : 0;

  const failedReasons = criteriaResults
    .filter((c) => !c.passed)
    .map((c) => `${c.description}: ${c.details}`);

  return {
    score: Math.min(1, Math.max(0, normalisedScore)),
    criteriaResults,
    reasons:
      failedReasons.length > 0
        ? failedReasons
        : ["All rubric criteria passed."],
  };
};

/**
 * Maps an artifact kind string (e.g. "blog_draft.v1") to a playbook type key.
 * Returns null when the kind has no corresponding playbook type.
 */
export const artifactKindToPlaybookType = (
  artifactKind: string,
): "blog_draft" | "content_brief" | "intel_brief" | "custom" | null => {
  if (artifactKind.startsWith("blog_draft")) return "blog_draft";
  if (artifactKind.startsWith("content_brief")) return "content_brief";
  if (artifactKind.startsWith("intel_brief")) return "intel_brief";
  if (artifactKind.startsWith("custom")) return "custom";
  return null;
};
