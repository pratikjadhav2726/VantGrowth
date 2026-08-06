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

/**
 * Stable snake_case payload for a `warmth.signal.v1` outbox event. Tenant
 * identity is authoritative in the tenant-scoped JetStream subject.
 */
const warmthSignalEventPayloadSchema = z.object({
  tenant_id: z.string().uuid().optional(),
  warmth_id: z.string().min(1),
  dedupe_key: z.string().min(1),
  source: z.string().min(1),
  subject_id: z.string().min(1),
  cold_override: z.boolean().default(false),
  touches: z.array(
    z.object({
      touch_type: warmthTouchTypeSchema,
      occurred_at: z.coerce.date(),
    }),
  ),
});

export type WarmthSignalEventPayload = z.infer<
  typeof warmthSignalEventPayloadSchema
>;

export const parseWarmthSignalEvent = (
  payload: Record<string, unknown>,
  tenantId: string,
): WarmthSignal => {
  const parsedTenantId = z.string().uuid().parse(tenantId);
  const event = warmthSignalEventPayloadSchema.parse(payload);

  if (event.tenant_id && event.tenant_id !== parsedTenantId) {
    throw new Error(
      "Warmth signal tenant_id does not match its JetStream subject.",
    );
  }

  return warmthSignalSchema.parse({
    tenantId: parsedTenantId,
    warmthId: event.warmth_id,
    dedupeKey: event.dedupe_key,
    source: event.source,
    subjectId: event.subject_id,
    coldOverride: event.cold_override,
    touches: event.touches.map((touch) => ({
      touchType: touch.touch_type,
      occurredAt: touch.occurred_at,
    })),
  });
};

export const warmthDispositionSchema = z.enum(["eligible", "blocked"]);

export const warmthResultSchema = warmthSignalSchema.extend({
  warmthScore: z.number().min(0).max(1),
  disposition: warmthDispositionSchema,
  nextTouchRecommendedAt: z.date().nullable(),
  rationale: z.array(z.string().min(1)),
  evaluatedAt: z.date(),
});

export type WarmthResult = z.infer<typeof warmthResultSchema>;
