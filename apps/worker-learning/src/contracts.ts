import { approvalFeedbackActionSchema } from "@growthos/db";
import { z } from "zod";

export const learningSignalSchema = z.object({
  tenantId: z.string().uuid(),
  learningId: z.string().min(1),
  dedupeKey: z.string().min(1),
  source: z.string().min(1),
  issueId: z.string().uuid(),
  outputType: z.string().min(1),
  action: approvalFeedbackActionSchema,
  editDistance: z.number().min(0).max(1).nullable().optional(),
  rubricFailures: z.array(z.string().min(1)).default([]),
  reviewerNote: z.string().optional(),
  learnOptIn: z.boolean().default(true),
});

export type LearningSignal = z.infer<typeof learningSignalSchema>;

export const learningPrioritySchema = z.enum(["high", "medium", "low"]);
export const learningDispositionSchema = z.enum(["candidate", "discarded"]);

export const learningCandidateSchema = learningSignalSchema.extend({
  disposition: learningDispositionSchema,
  priority: learningPrioritySchema,
  confidenceScore: z.number().min(0).max(1),
  reasons: z.array(z.string().min(1)),
  synthesizedAt: z.date(),
});

export type LearningCandidate = z.infer<typeof learningCandidateSchema>;
