import { z } from "zod";

export const signalPrioritySchema = z.enum(["P0", "P1", "P2", "P3"]);

export const incomingSignalSchema = z.object({
  tenantId: z.string().uuid(),
  signalId: z.string().min(1),
  dedupeKey: z.string().min(1),
  source: z.string().min(1),
  kind: z.string().min(1),
  payload: z.record(z.unknown()),
});

export type IncomingSignal = z.infer<typeof incomingSignalSchema>;

/** LLM-graded quality metadata for a signal. */
export const signalGradeSchema = z.object({
  relevance: z.number().min(0).max(1),
  urgency: z.enum(["low", "medium", "high"]),
  topicCategory: z.string().min(1),
  actionRecommendations: z.array(z.string()),
});

export type SignalGrade = z.infer<typeof signalGradeSchema>;

export const routedSignalSchema = incomingSignalSchema.extend({
  priority: signalPrioritySchema,
  targetAgent: z.string().min(1),
  halfLifeMinutes: z.number().int().positive(),
  routedAt: z.date(),
  /** Present when an LlmCallRunner is configured on the SignalRouter. */
  grade: signalGradeSchema.optional(),
});

export type RoutedSignal = z.infer<typeof routedSignalSchema>;
