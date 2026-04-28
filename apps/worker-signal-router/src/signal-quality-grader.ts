/**
 * SignalQualityGrader — Phase 1 / S2
 *
 * Grades an incoming signal using the `SIGNAL_GRADE_PROMPT` template to
 * extract structured quality metadata: relevance score, urgency, topic
 * category, and actionable recommendations.
 *
 * This enriches the `RoutedSignal` payload so downstream workers can
 * prioritise high-relevance signals without re-processing the raw text.
 *
 * Design:
 *   - `gradeSignal()` returns a `SignalGrade` or `null` on any failure
 *     (runner error, invalid JSON, schema violation).
 *   - The grader never blocks the routing critical path — errors are swallowed
 *     and the router continues with an ungraded signal.
 *   - The LLM may return snake_case keys; we normalise before parsing.
 */

import { type LlmCallRunner, SIGNAL_GRADE_PROMPT } from "@growthos/llm-harness";
import { z } from "zod";
import type { IncomingSignal, SignalGrade } from "./contracts.js";
import { signalGradeSchema } from "./contracts.js";

// LLM sometimes returns snake_case keys — accept both forms.
const llmGradeResponseSchema = z
  .object({
    relevance: z.number().min(0).max(1),
    urgency: z.enum(["low", "medium", "high"]),
    topic_category: z.string().optional(),
    topicCategory: z.string().optional(),
    action_recommendations: z.array(z.string()).optional(),
    actionRecommendations: z.array(z.string()).optional(),
  })
  .transform(
    (v): SignalGrade => ({
      relevance: v.relevance,
      urgency: v.urgency,
      topicCategory: v.topicCategory ?? v.topic_category ?? "general",
      actionRecommendations:
        v.actionRecommendations ?? v.action_recommendations ?? [],
    }),
  );

// Re-validate through the canonical schema after normalisation.
const parseGrade = (raw: unknown): SignalGrade | null => {
  const normalised = llmGradeResponseSchema.safeParse(raw);
  if (!normalised.success) return null;
  const canonical = signalGradeSchema.safeParse(normalised.data);
  return canonical.success ? canonical.data : null;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Attempts to grade a signal via the LLM runner.
 *
 * @param signal        The incoming signal to grade.
 * @param runner        Injected LlmCallRunner (StubLlmCallRunner in tests).
 * @param motionContext Human-readable description of the tenant's active motions.
 * @returns             Parsed `SignalGrade` or `null` on any failure.
 */
export const gradeSignal = async (
  signal: IncomingSignal,
  runner: LlmCallRunner,
  motionContext = "inbound_content, plg",
): Promise<SignalGrade | null> => {
  let content: string;
  try {
    const result = await runner.run(
      SIGNAL_GRADE_PROMPT,
      {
        signalType: signal.kind,
        source: signal.source,
        rawPayload: JSON.stringify(signal.payload, null, 2),
        motionContext,
      },
      { tenantId: signal.tenantId },
    );
    content = result.content;
  } catch {
    return null;
  }

  // Extract the first JSON object from the response.
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    return parseGrade(JSON.parse(match[0]));
  } catch {
    return null;
  }
};
