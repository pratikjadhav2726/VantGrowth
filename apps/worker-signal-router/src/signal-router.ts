import type { OutboxRepository } from "@growthos/db";
import type { LlmCallRunner } from "@growthos/llm-harness";
import {
  type IncomingSignal,
  type RoutedSignal,
  incomingSignalSchema,
  routedSignalSchema,
} from "./contracts.js";
import { gradeSignal } from "./signal-quality-grader.js";

export interface EventPublisher {
  publish(subject: string, payload: Record<string, unknown>): Promise<void>;
}

export interface SignalRouterDependencies {
  outboxRepository: OutboxRepository;
  /**
   * Retained as an optional compatibility seam for callers that need a
   * publisher reference. Domain delivery itself is intentionally outbox-only:
   * publishing directly here races the durable outbox drain and can duplicate
   * work after a process crash.
   */
  eventPublisher?: EventPublisher;
  /**
   * Optional LLM runner for signal quality grading.
   * When injected, each routed signal is enriched with a `grade` object
   * containing relevance score, urgency, topic category, and action
   * recommendations before being emitted to the outbox + NATS.
   *
   * Inject `StubLlmCallRunner` in tests; `OpenAiLlmCallRunner.fromEnv()` in
   * production (behind `ENABLE_SIGNAL_GRADING=true`).
   */
  llmCallRunner?: LlmCallRunner;
  /**
   * Human-readable description of the tenant's active GTM motions.
   * Passed to the signal grading prompt.  Defaults to "inbound_content, plg".
   */
  motionContext?: string;
}

export const classifySignal = (
  signal: IncomingSignal,
): Omit<RoutedSignal, keyof IncomingSignal | "routedAt" | "grade"> => {
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

  // The initial production motion is signal-led inbound content. Unknown
  // market signals must enter the intelligence loop rather than disappear
  // into an unimplemented reporting queue.
  return {
    priority: "P2",
    targetAgent: "intel_director",
    halfLifeMinutes: 1440,
  };
};

export class SignalRouter {
  constructor(private readonly deps: SignalRouterDependencies) {}

  async route(input: IncomingSignal): Promise<RoutedSignal> {
    const signal = incomingSignalSchema.parse(input);

    // Attempt LLM grading — never throws; returns null on failure.
    const grade = this.deps.llmCallRunner
      ? await gradeSignal(
          signal,
          this.deps.llmCallRunner,
          this.deps.motionContext,
        )
      : undefined;

    const routed = routedSignalSchema.parse({
      ...signal,
      ...classifySignal(signal),
      routedAt: new Date(),
      ...(grade !== null && grade !== undefined ? { grade } : {}),
    });

    const payload: Record<string, unknown> = {
      signal_id: routed.signalId,
      source: routed.source,
      kind: routed.kind,
      priority: routed.priority,
      target_agent: routed.targetAgent,
      half_life_minutes: routed.halfLifeMinutes,
      payload: routed.payload,
      routed_at: routed.routedAt.toISOString(),
    };

    if (routed.grade) {
      payload.grade = {
        relevance: routed.grade.relevance,
        urgency: routed.grade.urgency,
        topic_category: routed.grade.topicCategory,
        action_recommendations: routed.grade.actionRecommendations,
      };
    }

    await this.deps.outboxRepository.enqueue({
      tenantId: routed.tenantId,
      eventType: "signal.routed.v1",
      idempotencyKey: routed.dedupeKey,
      payload,
    });

    return routed;
  }
}
