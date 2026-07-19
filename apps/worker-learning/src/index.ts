/**
 * Durable learning loop entry point.
 *
 * Founder feedback and critique results are independent JetStream consumers.
 * Each handler acknowledges only after the learning state transition and its
 * downstream event are safely written to the Postgres outbox.
 */

import { startDurableJetStreamConsumer } from "@growthos/core";
import {
  PostgresExperimentRepository,
  PostgresLearningProposalRepository,
  PostgresOutboxRepository,
  PostgresPlaybookVersionsRepository,
  PostgresPromotionEvidenceProvider,
  createDbFromEnv,
} from "@growthos/db";
import { createLogger, initOtelSdk } from "@growthos/observability";
import { z } from "zod";
import { LearningWorker } from "./learning-worker.js";

const log = createLogger("growthos.worker-learning");

interface LearningRuntime {
  worker: LearningWorker;
  outboxRepository: PostgresOutboxRepository;
}

const createLearningRuntimeFromEnv = (): LearningRuntime => {
  const db = createDbFromEnv();
  const context = { actorKind: "system" } as const;
  const outboxRepository = new PostgresOutboxRepository(db, {
    actorKind: "system",
  });
  const learningProposalRepository = new PostgresLearningProposalRepository(
    db,
    context,
  );
  const experimentRepository = new PostgresExperimentRepository(db, context);

  return {
    outboxRepository,
    worker: new LearningWorker({
      outboxRepository,
      playbookRepository: new PostgresPlaybookVersionsRepository(db),
      learningProposalRepository,
      promotionEvidenceProvider: new PostgresPromotionEvidenceProvider(
        learningProposalRepository,
        experimentRepository,
        process.env.LEARNING_GUARDRAIL_METRIC_NAME
          ? {
              guardrailMetricName:
                process.env.LEARNING_GUARDRAIL_METRIC_NAME,
            }
          : {},
      ),
    }),
  };
};

export const createLearningWorkerFromEnv = async (): Promise<LearningWorker> =>
  createLearningRuntimeFromEnv().worker;

const tenantIdFromSubject = (subject: string): string => {
  const parts = subject.split(".");
  const tenantId = parts[1];
  if (parts[0] !== "t" || !tenantId) {
    throw new Error(`Invalid tenant-scoped event subject: ${subject}`);
  }
  return tenantId;
};

const approvedLearningProposalPayloadSchema = z.object({
  proposal_id: z.string().uuid(),
});

const enqueueDeadLetter = async (
  outboxRepository: PostgresOutboxRepository,
  worker: string,
  payload: Record<string, unknown> | null,
  subject: string,
  streamSequence: number,
  redeliveryCount: number,
  error: Error,
): Promise<void> => {
  const tenantId =
    (typeof payload?.tenantId === "string" ? payload.tenantId : undefined) ??
    (typeof payload?.tenant_id === "string" ? payload.tenant_id : undefined) ??
    tenantIdFromSubject(subject);

  await outboxRepository.enqueue({
    tenantId,
    eventType: "worker.dead_lettered.v1",
    idempotencyKey: `${worker}:${streamSequence}`,
    payload: {
      worker,
      source_subject: subject,
      stream_sequence: streamSequence,
      redelivery_count: redeliveryCount,
      error: error.message,
      failed_payload: payload ?? {},
      occurred_at: new Date().toISOString(),
    },
  });
};

const startLearningSignalConsumer = async (
  worker: LearningWorker,
  outboxRepository: PostgresOutboxRepository,
): Promise<void> => {
  const subject =
    process.env.LEARNING_SIGNAL_SUBJECT ?? "t.*.learning.signal.v1";

  await startDurableJetStreamConsumer(
    {
      servers: process.env.NATS_SERVERS ?? "nats://localhost:4222",
      streamName: process.env.GROWTHOS_JETSTREAM_STREAM ?? "GROWTHOS",
      subject,
      durableName:
        process.env.LEARNING_SIGNAL_DURABLE_NAME ?? "growthos_learning_signal",
      queueGroup:
        process.env.LEARNING_SIGNAL_QUEUE_GROUP ?? "growthos-worker-learning",
      clientName: process.env.NATS_CLIENT_NAME ?? "growthos-worker-learning",
      ackWaitMs: Number(process.env.LEARNING_SIGNAL_ACK_WAIT_MS ?? "60000"),
      maxDeliver: Number(process.env.LEARNING_SIGNAL_MAX_DELIVER ?? "5"),
      retryDelayMs: Number(
        process.env.LEARNING_SIGNAL_RETRY_DELAY_MS ?? "5000",
      ),
      maxAckPending: Number(
        process.env.LEARNING_SIGNAL_MAX_ACK_PENDING ?? "25",
      ),
    },
    async (payload) => {
      await worker.process(payload);
    },
    {
      onError: (error, context) => {
        log.error(
          {
            err: error,
            subject: context.subject,
            sequence: context.streamSequence,
          },
          "learning signal processing failed",
        );
      },
      onExhausted: async (payload, context, error) =>
        enqueueDeadLetter(
          outboxRepository,
          "learning_signal",
          payload,
          context.subject,
          context.streamSequence,
          context.redeliveryCount,
          error,
        ),
    },
  );
};

const startCritiqueConsumer = async (
  worker: LearningWorker,
  outboxRepository: PostgresOutboxRepository,
): Promise<void> => {
  const subject =
    process.env.LEARNING_CRITIQUE_SUBJECT ?? "t.*.critique.completed.v1";

  await startDurableJetStreamConsumer(
    {
      servers: process.env.NATS_SERVERS ?? "nats://localhost:4222",
      streamName: process.env.GROWTHOS_JETSTREAM_STREAM ?? "GROWTHOS",
      subject,
      durableName:
        process.env.LEARNING_CRITIQUE_DURABLE_NAME ??
        "growthos_learning_critique",
      queueGroup:
        process.env.LEARNING_CRITIQUE_QUEUE_GROUP ??
        "growthos-worker-learning-critique",
      clientName: process.env.NATS_CLIENT_NAME ?? "growthos-worker-learning",
      ackWaitMs: Number(process.env.LEARNING_CRITIQUE_ACK_WAIT_MS ?? "60000"),
      maxDeliver: Number(process.env.LEARNING_CRITIQUE_MAX_DELIVER ?? "5"),
      retryDelayMs: Number(
        process.env.LEARNING_CRITIQUE_RETRY_DELAY_MS ?? "5000",
      ),
      maxAckPending: Number(
        process.env.LEARNING_CRITIQUE_MAX_ACK_PENDING ?? "25",
      ),
    },
    async (payload, context) => {
      await worker.processFromCritique(
        tenantIdFromSubject(context.subject),
        payload,
      );
    },
    {
      onError: (error, context) => {
        log.error(
          {
            err: error,
            subject: context.subject,
            sequence: context.streamSequence,
          },
          "critique learning processing failed",
        );
      },
      onExhausted: async (payload, context, error) =>
        enqueueDeadLetter(
          outboxRepository,
          "learning_critique",
          payload,
          context.subject,
          context.streamSequence,
          context.redeliveryCount,
          error,
        ),
    },
  );
};

/**
 * A high-risk proposal is only retried after an explicit founder approval was
 * recorded. The consumer re-reads evidence and does not trust the approval
 * event as a substitute for the promotion gate.
 */
const startApprovedProposalConsumer = async (
  worker: LearningWorker,
  outboxRepository: PostgresOutboxRepository,
): Promise<void> => {
  const subject =
    process.env.LEARNING_PROPOSAL_APPROVED_SUBJECT ??
    "t.*.learning.proposal.approved.v1";

  await startDurableJetStreamConsumer(
    {
      servers: process.env.NATS_SERVERS ?? "nats://localhost:4222",
      streamName: process.env.GROWTHOS_JETSTREAM_STREAM ?? "GROWTHOS",
      subject,
      durableName:
        process.env.LEARNING_PROPOSAL_APPROVED_DURABLE_NAME ??
        "growthos_learning_proposal_approved",
      queueGroup:
        process.env.LEARNING_PROPOSAL_APPROVED_QUEUE_GROUP ??
        "growthos-worker-learning-proposal-approved",
      clientName: process.env.NATS_CLIENT_NAME ?? "growthos-worker-learning",
      ackWaitMs: Number(
        process.env.LEARNING_PROPOSAL_APPROVED_ACK_WAIT_MS ?? "60000",
      ),
      maxDeliver: Number(
        process.env.LEARNING_PROPOSAL_APPROVED_MAX_DELIVER ?? "5",
      ),
      retryDelayMs: Number(
        process.env.LEARNING_PROPOSAL_APPROVED_RETRY_DELAY_MS ?? "5000",
      ),
      maxAckPending: Number(
        process.env.LEARNING_PROPOSAL_APPROVED_MAX_ACK_PENDING ?? "25",
      ),
    },
    async (payload, context) => {
      const parsed = approvedLearningProposalPayloadSchema.parse(payload);
      await worker.processApprovedProposal(
        tenantIdFromSubject(context.subject),
        parsed.proposal_id,
      );
    },
    {
      onError: (error, context) => {
        log.error(
          {
            err: error,
            subject: context.subject,
            sequence: context.streamSequence,
          },
          "approved learning proposal processing failed",
        );
      },
      onExhausted: async (payload, context, error) =>
        enqueueDeadLetter(
          outboxRepository,
          "learning_proposal_approved",
          payload,
          context.subject,
          context.streamSequence,
          context.redeliveryCount,
          error,
        ),
    },
  );
};

if (process.env.WORKER_BOOTSTRAP === "true") {
  initOtelSdk({ serviceName: "growthos.worker-learning" });
  const { worker, outboxRepository } = createLearningRuntimeFromEnv();
  await Promise.all([
    startLearningSignalConsumer(worker, outboxRepository),
    startCritiqueConsumer(worker, outboxRepository),
    startApprovedProposalConsumer(worker, outboxRepository),
  ]);
  log.info(
    {
      learningSignalSubject:
        process.env.LEARNING_SIGNAL_SUBJECT ?? "t.*.learning.signal.v1",
      critiqueSubject:
        process.env.LEARNING_CRITIQUE_SUBJECT ??
        "t.*.critique.completed.v1",
      approvedProposalSubject:
        process.env.LEARNING_PROPOSAL_APPROVED_SUBJECT ??
        "t.*.learning.proposal.approved.v1",
    },
    "@growthos/worker-learning initialized",
  );
}

export * from "./contracts.js";
export * from "./learning-worker.js";
export * from "./nats-publisher.js";
