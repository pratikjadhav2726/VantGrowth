import type { OutboxRepository } from "@growthos/db";
import { tenantScopedSubject } from "@growthos/db";
import {
  type IncomingSignal,
  type RoutedSignal,
  incomingSignalSchema,
  routedSignalSchema,
} from "./contracts.js";

export interface EventPublisher {
  publish(subject: string, payload: Record<string, unknown>): Promise<void>;
}

export interface SignalRouterDependencies {
  outboxRepository: OutboxRepository;
  eventPublisher: EventPublisher;
}

export const classifySignal = (
  signal: IncomingSignal,
): Omit<RoutedSignal, keyof IncomingSignal | "routedAt"> => {
  if (signal.kind === "prospect.replied") {
    return {
      priority: "P0",
      targetAgent: "warm_outbound_researcher",
      halfLifeMinutes: 30,
    };
  }

  if (signal.kind === "competitor.pricing_change") {
    return {
      priority: "P1",
      targetAgent: "intel_director",
      halfLifeMinutes: 120,
    };
  }

  if (signal.kind === "approval.rejected") {
    return {
      priority: "P2",
      targetAgent: "learning_director",
      halfLifeMinutes: 1440,
    };
  }

  return {
    priority: "P3",
    targetAgent: "reporting_director",
    halfLifeMinutes: 10080,
  };
};

export class SignalRouter {
  constructor(private readonly deps: SignalRouterDependencies) {}

  async route(input: IncomingSignal): Promise<RoutedSignal> {
    const signal = incomingSignalSchema.parse(input);
    const routed = routedSignalSchema.parse({
      ...signal,
      ...classifySignal(signal),
      routedAt: new Date(),
    });

    const payload = {
      signal_id: routed.signalId,
      source: routed.source,
      kind: routed.kind,
      priority: routed.priority,
      target_agent: routed.targetAgent,
      half_life_minutes: routed.halfLifeMinutes,
      payload: routed.payload,
      routed_at: routed.routedAt.toISOString(),
    };

    await this.deps.outboxRepository.enqueue({
      tenantId: routed.tenantId,
      eventType: "signal.routed.v1",
      idempotencyKey: routed.dedupeKey,
      payload,
    });

    await this.deps.eventPublisher.publish(
      tenantScopedSubject(routed.tenantId, "signal.routed.v1"),
      payload,
    );

    return routed;
  }
}
