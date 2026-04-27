import { z } from "zod";

export const tenantIdSchema = z.string().uuid();
export const uuidSchema = z.string().uuid();

export const outboxEventTypeSchema = z
  .string()
  .min(1)
  .regex(/^[a-z][a-z0-9._-]+\.v[0-9]+$/);

export const enqueueOutboxEventSchema = z.object({
  tenantId: tenantIdSchema,
  eventType: outboxEventTypeSchema,
  idempotencyKey: z.string().min(1),
  payload: z.record(z.unknown())
});

export type EnqueueOutboxEvent = z.infer<typeof enqueueOutboxEventSchema>;

export const storedOutboxEventSchema = enqueueOutboxEventSchema.extend({
  id: z.string().min(1),
  createdAt: z.date(),
  consumedAt: z.date().nullable()
});

export type StoredOutboxEvent = z.infer<typeof storedOutboxEventSchema>;

export const approvalFeedbackActionSchema = z.enum([
  "approved",
  "edited_then_approved",
  "rejected",
  "auto_approved"
]);

export const createApprovalFeedbackSchema = z.object({
  tenantId: tenantIdSchema,
  issueId: uuidSchema,
  outputType: z.string().min(1),
  action: approvalFeedbackActionSchema,
  editDistance: z.number().min(0).max(1).nullable().optional(),
  rubricFailures: z.array(z.string().min(1)).default([]),
  reviewerNote: z.string().optional(),
  learnOptIn: z.boolean().default(true)
});

export type CreateApprovalFeedback = z.input<typeof createApprovalFeedbackSchema>;
