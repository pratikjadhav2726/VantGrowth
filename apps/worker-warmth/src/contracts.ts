import { z } from "zod";

export const warmthTouchTypeSchema = z.enum([
  "linkedin_view",
  "linkedin_like",
  "linkedin_comment",
  "content_read",
  "reply",
  "meeting",
]);

export const warmthTouchSchema = z.object({
  touchType: warmthTouchTypeSchema,
  occurredAt: z.coerce.date(),
});

export const warmthSignalSchema = z.object({
  tenantId: z.string().uuid(),
  warmthId: z.string().min(1),
  dedupeKey: z.string().min(1),
  source: z.string().min(1),
  subjectId: z.string().min(1),
  coldOverride: z.boolean().default(false),
  touches: z.array(warmthTouchSchema),
});

export type WarmthSignal = z.infer<typeof warmthSignalSchema>;

export const warmthDispositionSchema = z.enum(["eligible", "blocked"]);

export const warmthResultSchema = warmthSignalSchema.extend({
  warmthScore: z.number().min(0).max(1),
  disposition: warmthDispositionSchema,
  nextTouchRecommendedAt: z.date().nullable(),
  rationale: z.array(z.string().min(1)),
  evaluatedAt: z.date(),
});

export type WarmthResult = z.infer<typeof warmthResultSchema>;
