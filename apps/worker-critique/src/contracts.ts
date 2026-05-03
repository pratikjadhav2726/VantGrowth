import { z } from "zod";

export const critiqueVerdictSchema = z.enum(["approve", "revise", "reject"]);

export const critiqueRequestSchema = z.object({
  tenantId: z.string().uuid(),
  critiqueId: z.string().min(1),
  dedupeKey: z.string().min(1),
  source: z.string().min(1),
  artifactKind: z.string().min(1),
  artifactId: z.string().min(1),
  promptVersion: z.string().min(1),
  candidateOutput: z.string().min(1),
  reviewerNotes: z.array(z.string().min(1)).default([]),
});

export type CritiqueRequest = z.infer<typeof critiqueRequestSchema>;

export const critiqueResultSchema = critiqueRequestSchema.extend({
  verdict: critiqueVerdictSchema,
  confidenceScore: z.number().min(0).max(1),
  reasons: z.array(z.string().min(1)),
  critiquedAt: z.date(),
});

export type CritiqueResult = z.infer<typeof critiqueResultSchema>;
