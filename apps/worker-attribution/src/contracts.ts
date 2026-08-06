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

/**
 * The event shape placed in the transactional outbox and later delivered over
 * JetStream. Tenant identity comes from the `t.{tenantId}.*` subject; an
 * optional payload tenant is retained only as a consistency check.
 */
const attributionSignalEventPayloadSchema = z.object({
  tenant_id: z.string().uuid().optional(),
  attribution_id: z.string().min(1),
  dedupe_key: z.string().min(1),
  source: z.string().min(1),
  opportunity_id: z.string().min(1),
  account_id: z.string().min(1),
  window: attributionWindowSchema,
  touchpoints: z.array(
    z.object({
      channel: z.string().min(1),
      campaign_id: z.string().min(1).optional(),
      event_type: z.string().min(1),
      occurred_at: z.coerce.date(),
    }),
  ),
  conversion_value_micros: z.number().int().nonnegative(),
});

export type AttributionSignalEventPayload = z.infer<
  typeof attributionSignalEventPayloadSchema
>;

export const parseAttributionSignalEvent = (
  payload: Record<string, unknown>,
  tenantId: string,
): AttributionSignal => {
  const parsedTenantId = z.string().uuid().parse(tenantId);
  const event = attributionSignalEventPayloadSchema.parse(payload);

  if (event.tenant_id && event.tenant_id !== parsedTenantId) {
    throw new Error(
      "Attribution signal tenant_id does not match its JetStream subject.",
    );
  }

  return attributionSignalSchema.parse({
    tenantId: parsedTenantId,
    attributionId: event.attribution_id,
    dedupeKey: event.dedupe_key,
    source: event.source,
    opportunityId: event.opportunity_id,
    accountId: event.account_id,
    window: event.window,
    touchpoints: event.touchpoints.map((touchpoint) => ({
      channel: touchpoint.channel,
      ...(touchpoint.campaign_id ? { campaignId: touchpoint.campaign_id } : {}),
      eventType: touchpoint.event_type,
      occurredAt: touchpoint.occurred_at,
    })),
    conversionValueMicros: event.conversion_value_micros,
  });
};

export const attributionRollupSchema = attributionSignalSchema.extend({
  totalTouchpoints: z.number().int().nonnegative(),
  uniqueChannels: z.number().int().nonnegative(),
  topChannel: z.string().min(1).nullable(),
  synthesizedAt: z.date(),
});

export type AttributionRollup = z.infer<typeof attributionRollupSchema>;
