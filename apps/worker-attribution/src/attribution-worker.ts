import type { OutboxRepository } from "@growthos/db";
import {
  type AttributionRollup,
  type AttributionSignal,
  attributionRollupSchema,
  attributionSignalSchema,
} from "./contracts.js";

export interface AttributionWorkerDependencies {
  outboxRepository: OutboxRepository;
}

export const synthesizeAttributionRollup = (
  input: AttributionSignal,
): Omit<AttributionRollup, keyof AttributionSignal | "synthesizedAt"> => {
  const channels = input.touchpoints.map((item) => item.channel);
  const uniqueChannels = new Set(channels);
  const counts = channels.reduce<Record<string, number>>((acc, channel) => {
    acc[channel] = (acc[channel] ?? 0) + 1;
    return acc;
  }, {});

  const topChannel =
    Object.entries(counts).sort((left, right) => right[1] - left[1])[0]?.[0] ??
    null;

  return {
    totalTouchpoints: input.touchpoints.length,
    uniqueChannels: uniqueChannels.size,
    topChannel,
  };
};

export class AttributionWorker {
  constructor(private readonly deps: AttributionWorkerDependencies) {}

  async process(input: AttributionSignal): Promise<AttributionRollup> {
    const signal = attributionSignalSchema.parse(input);
    const rollup = attributionRollupSchema.parse({
      ...signal,
      ...synthesizeAttributionRollup(signal),
      synthesizedAt: new Date(),
    });

    const payload = {
      tenant_id: rollup.tenantId,
      attribution_id: rollup.attributionId,
      source: rollup.source,
      opportunity_id: rollup.opportunityId,
      account_id: rollup.accountId,
      window: rollup.window,
      total_touchpoints: rollup.totalTouchpoints,
      unique_channels: rollup.uniqueChannels,
      top_channel: rollup.topChannel,
      conversion_value_micros: rollup.conversionValueMicros,
      synthesized_at: rollup.synthesizedAt.toISOString(),
    };

    await this.deps.outboxRepository.enqueue({
      tenantId: rollup.tenantId,
      eventType: "attribution.rollup.computed.v1",
      idempotencyKey: rollup.dedupeKey,
      payload,
    });

    return rollup;
  }
}
