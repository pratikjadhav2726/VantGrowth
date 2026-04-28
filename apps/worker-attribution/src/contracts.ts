import { z } from "zod";

export const attributionWindowSchema = z.enum(["7d", "30d", "60d"]);

export const attributionSignalSchema = z.object({
  tenantId: z.string().uuid(),
  attributionId: z.string().min(1),
  dedupeKey: z.string().min(1),
  source: z.string().min(1),
  opportunityId: z.string().min(1),
  accountId: z.string().min(1),
  window: attributionWindowSchema,
  touchpoints: z.array(
    z.object({
      channel: z.string().min(1),
      campaignId: z.string().min(1).optional(),
      eventType: z.string().min(1),
      occurredAt: z.coerce.date(),
    }),
  ),
  conversionValueMicros: z.number().int().nonnegative(),
});

export type AttributionSignal = z.infer<typeof attributionSignalSchema>;

export const attributionRollupSchema = attributionSignalSchema.extend({
  totalTouchpoints: z.number().int().nonnegative(),
  uniqueChannels: z.number().int().nonnegative(),
  topChannel: z.string().min(1).nullable(),
  synthesizedAt: z.date(),
});

export type AttributionRollup = z.infer<typeof attributionRollupSchema>;
