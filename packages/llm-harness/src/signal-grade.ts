/**
 * Signal quality grading — shared by API (`POST /v1/signals/grade`), workers
 * (`SignalRouter`), and tests.
 *
 * Uses `SIGNAL_GRADE_PROMPT` and returns structured `SignalGrade` or `null`
 * on any failure (runner error, invalid JSON, schema violation).
 */

import { z } from "zod";
import type { LlmCallRunner } from "./llm-call-runner.js";
import { SIGNAL_GRADE_PROMPT } from "./prompt-template.js";

// ---------------------------------------------------------------------------
// Canonical grade schema (exported for consumers)
// ---------------------------------------------------------------------------

export const signalGradeSchema = z.object({
  relevance: z.number().min(0).max(1),
  urgency: z.enum(["low", "medium", "high"]),
  topicCategory: z.string().min(1),
  actionRecommendations: z.array(z.string()),
});

export type SignalGrade = z.infer<typeof signalGradeSchema>;

// ---------------------------------------------------------------------------
// LLM response normalisation (snake_case ↔ camelCase)
// ---------------------------------------------------------------------------

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

const parseGrade = (raw: unknown): SignalGrade | null => {
  const normalised = llmGradeResponseSchema.safeParse(raw);
  if (!normalised.success) return null;
  const canonical = signalGradeSchema.safeParse(normalised.data);
  return canonical.success ? canonical.data : null;
};

// ---------------------------------------------------------------------------
// Input shape (minimal — no DB / routing fields required)
// ---------------------------------------------------------------------------

export interface SignalGradePayloadInput {
  tenantId: string;
  /** Signal category / kind, e.g. same values as ingest `signalType`. */
  signalType: string;
  source: string;
  payload: Record<string, unknown>;
}

/**
 * Grades a signal payload using the LLM. Returns `null` on any failure.
 */
export const gradeSignalPayload = async (
  input: SignalGradePayloadInput,
  runner: LlmCallRunner,
  motionContext = "inbound_content, plg",
): Promise<SignalGrade | null> => {
  let content: string;
  try {
    const result = await runner.run(
      SIGNAL_GRADE_PROMPT,
      {
        signalType: input.signalType,
        source: input.source,
        rawPayload: JSON.stringify(input.payload, null, 2),
        motionContext,
      },
      { tenantId: input.tenantId },
    );
    content = result.content;
  } catch {
    return null;
  }

  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    return parseGrade(JSON.parse(match[0]));
  } catch {
    return null;
  }
};
