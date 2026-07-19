import type { OutboxRepository } from "@growthos/db";
import {
  type WarmthResult,
  type WarmthSignal,
  warmthResultSchema,
  warmthSignalSchema,
} from "./contracts.js";

export interface WarmthWorkerDependencies {
  outboxRepository: OutboxRepository;
  now?: () => Date;
}

const TOUCH_WEIGHTS: Record<string, number> = {
  linkedin_view: 0.05,
  linkedin_like: 0.12,
  linkedin_comment: 0.18,
  content_read: 0.2,
  reply: 0.45,
  meeting: 1,
};

const HALF_LIFE_DAYS = 14;
const WARMTH_GATE_THRESHOLD = 0.3;

const decayMultiplier = (daysSinceTouch: number): number =>
  2 ** (-daysSinceTouch / HALF_LIFE_DAYS);

export const computeWarmthScore = (
  signal: WarmthSignal,
  now: Date = new Date(),
): number => {
  const score = signal.touches.reduce((acc, touch) => {
    const weight = TOUCH_WEIGHTS[touch.touchType] ?? 0;
    const ageMs = Math.max(0, now.getTime() - touch.occurredAt.getTime());
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    return acc + weight * decayMultiplier(ageDays);
  }, 0);

  return Math.max(0, Math.min(1, score));
};

export const evaluateWarmthSignal = (
  signal: WarmthSignal,
  now: Date = new Date(),
): Omit<WarmthResult, keyof WarmthSignal | "evaluatedAt"> => {
  const warmthScore = computeWarmthScore(signal, now);
  const passesGate = warmthScore >= WARMTH_GATE_THRESHOLD;
  const eligible = passesGate || signal.coldOverride;

  return {
    warmthScore,
    disposition: eligible ? "eligible" : "blocked",
    nextTouchRecommendedAt: eligible
      ? null
      : new Date(now.getTime() + 24 * 60 * 60 * 1000),
    rationale: eligible
      ? signal.coldOverride && !passesGate
        ? ["Cold override enabled despite warmth score below threshold."]
        : ["Warmth threshold satisfied for outbound progression."]
      : [
          "Warmth score below threshold; additional engagement touches required.",
        ],
  };
};

export class WarmthWorker {
  constructor(private readonly deps: WarmthWorkerDependencies) {}

  async process(input: WarmthSignal): Promise<WarmthResult> {
    const signal = warmthSignalSchema.parse(input);
    const evaluatedAt = this.deps.now?.() ?? new Date();
    const result = warmthResultSchema.parse({
      ...signal,
      ...evaluateWarmthSignal(signal, evaluatedAt),
      evaluatedAt,
    });

    const payload = {
      tenant_id: result.tenantId,
      warmth_id: result.warmthId,
      source: result.source,
      subject_id: result.subjectId,
      warmth_score: result.warmthScore,
      disposition: result.disposition,
      cold_override: result.coldOverride,
      next_touch_recommended_at:
        result.nextTouchRecommendedAt?.toISOString() ?? null,
      rationale: result.rationale,
      evaluated_at: result.evaluatedAt.toISOString(),
    };

    await this.deps.outboxRepository.enqueue({
      tenantId: result.tenantId,
      eventType: "warmth.evaluated.v1",
      idempotencyKey: result.dedupeKey,
      payload,
    });

    return result;
  }
}
