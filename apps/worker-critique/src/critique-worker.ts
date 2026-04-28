import type { OutboxRepository } from "@growthos/db";
import { tenantScopedSubject } from "@growthos/db";
import {
  type CritiqueRequest,
  type CritiqueResult,
  critiqueRequestSchema,
  critiqueResultSchema,
} from "./contracts.js";

export interface EventPublisher {
  publish(subject: string, payload: Record<string, unknown>): Promise<void>;
}

export interface CritiqueWorkerDependencies {
  outboxRepository: OutboxRepository;
  eventPublisher: EventPublisher;
}

export const scoreCritique = (
  input: CritiqueRequest,
): Omit<CritiqueResult, keyof CritiqueRequest | "critiquedAt"> => {
  const candidateLength = input.candidateOutput.trim().length;
  const hasReviewerNotes = input.reviewerNotes.length > 0;

  if (candidateLength < 120 || hasReviewerNotes) {
    return {
      verdict: "revise",
      confidenceScore: 0.52,
      reasons: ["Output needs stronger evidence and tighter structure."],
    };
  }

  if (candidateLength > 1200) {
    return {
      verdict: "reject",
      confidenceScore: 0.34,
      reasons: ["Output is too long for the current distribution channel."],
    };
  }

  return {
    verdict: "approve",
    confidenceScore: 0.86,
    reasons: ["Output passes structural quality checks."],
  };
};

export class CritiqueWorker {
  constructor(private readonly deps: CritiqueWorkerDependencies) {}

  async critique(input: CritiqueRequest): Promise<CritiqueResult> {
    const request = critiqueRequestSchema.parse(input);
    const result = critiqueResultSchema.parse({
      ...request,
      ...scoreCritique(request),
      critiquedAt: new Date(),
    });

    const payload = {
      critique_id: result.critiqueId,
      source: result.source,
      artifact_kind: result.artifactKind,
      artifact_id: result.artifactId,
      prompt_version: result.promptVersion,
      verdict: result.verdict,
      confidence_score: result.confidenceScore,
      reasons: result.reasons,
      critiqued_at: result.critiquedAt.toISOString(),
    };

    await this.deps.outboxRepository.enqueue({
      tenantId: result.tenantId,
      eventType: "critique.completed.v1",
      idempotencyKey: result.dedupeKey,
      payload,
    });

    await this.deps.eventPublisher.publish(
      tenantScopedSubject(result.tenantId, "critique.completed.v1"),
      payload,
    );

    return result;
  }
}
