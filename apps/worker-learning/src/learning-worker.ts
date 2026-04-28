import type { OutboxRepository } from "@growthos/db";
import { tenantScopedSubject } from "@growthos/db";
import {
  type LearningCandidate,
  type LearningSignal,
  learningCandidateSchema,
  learningSignalSchema,
} from "./contracts.js";

export interface EventPublisher {
  publish(subject: string, payload: Record<string, unknown>): Promise<void>;
}

export interface LearningWorkerDependencies {
  outboxRepository: OutboxRepository;
  eventPublisher: EventPublisher;
}

export const synthesizeLearningCandidate = (
  input: LearningSignal,
): Omit<LearningCandidate, keyof LearningSignal | "synthesizedAt"> => {
  if (!input.learnOptIn) {
    return {
      disposition: "discarded",
      priority: "low",
      confidenceScore: 0.15,
      reasons: [
        "Founder disabled learning capture for this approval decision.",
      ],
    };
  }

  if (input.action === "rejected" || input.rubricFailures.length > 0) {
    return {
      disposition: "candidate",
      priority: "high",
      confidenceScore: 0.82,
      reasons: [
        "Rejection/rubric failures provide direct corrective signal for playbook updates.",
      ],
    };
  }

  if (
    input.action === "edited_then_approved" &&
    (input.editDistance ?? 0) >= 0.15
  ) {
    return {
      disposition: "candidate",
      priority: "medium",
      confidenceScore: 0.69,
      reasons: [
        "Significant founder edits indicate an improvable generation pattern.",
      ],
    };
  }

  if (input.action === "approved" && (input.editDistance ?? 0) < 0.1) {
    return {
      disposition: "candidate",
      priority: "low",
      confidenceScore: 0.56,
      reasons: [
        "Low-edit approval confirms existing playbook behavior for this output type.",
      ],
    };
  }

  return {
    disposition: "discarded",
    priority: "low",
    confidenceScore: 0.24,
    reasons: ["Signal quality is below learning candidate thresholds."],
  };
};

export class LearningWorker {
  constructor(private readonly deps: LearningWorkerDependencies) {}

  async process(input: LearningSignal): Promise<LearningCandidate> {
    const signal = learningSignalSchema.parse(input);
    const candidate = learningCandidateSchema.parse({
      ...signal,
      ...synthesizeLearningCandidate(signal),
      synthesizedAt: new Date(),
    });

    const payload = {
      learning_id: candidate.learningId,
      source: candidate.source,
      issue_id: candidate.issueId,
      output_type: candidate.outputType,
      action: candidate.action,
      disposition: candidate.disposition,
      priority: candidate.priority,
      confidence_score: candidate.confidenceScore,
      reasons: candidate.reasons,
      rubric_failures: candidate.rubricFailures,
      edit_distance: candidate.editDistance ?? null,
      learn_opt_in: candidate.learnOptIn,
      synthesized_at: candidate.synthesizedAt.toISOString(),
    };

    await this.deps.outboxRepository.enqueue({
      tenantId: candidate.tenantId,
      eventType: "learning.candidate.synthesized.v1",
      idempotencyKey: candidate.dedupeKey,
      payload,
    });

    await this.deps.eventPublisher.publish(
      tenantScopedSubject(
        candidate.tenantId,
        "learning.candidate.synthesized.v1",
      ),
      payload,
    );

    return candidate;
  }
}
