/**
 * Durable quality gate for generated blog drafts.
 *
 * Every published draft is consumed from JetStream with explicit acknowledgments
 * only after the critique result has been persisted to the transactional outbox.
 * This keeps the quality and learning loops recoverable across worker restarts.
 */

import { startDurableJetStreamConsumer } from "@growthos/core";
import {
  PostgresOutboxRepository,
  PostgresPlaybookVersionsRepository,
  createDbFromEnv,
} from "@growthos/db";
import { OpenAiLlmCallRunner } from "@growthos/llm-harness";
import { createLogger, initOtelSdk } from "@growthos/observability";
import {
  CritiqueWorker,
  createBlogDraftCritiqueRequest,
} from "./critique-worker.js";

const log = createLogger("growthos.worker-critique");

interface CritiqueRuntime {
  worker: CritiqueWorker;
  outboxRepository: PostgresOutboxRepository;
}

const createCritiqueRuntimeFromEnv = (): CritiqueRuntime => {
  const db = createDbFromEnv();
  const outboxRepository = new PostgresOutboxRepository(db, {
    actorKind: "system",
  });

  return {
    outboxRepository,
    worker: new CritiqueWorker({
      outboxRepository,
      playbookRepository: new PostgresPlaybookVersionsRepository(db),
      ...(process.env.OPENAI_API_KEY
        ? { llmCallRunner: OpenAiLlmCallRunner.fromEnv() }
        : {}),
    }),
  };
};

export const createCritiqueWorkerFromEnv = async (): Promise<CritiqueWorker> =>
  createCritiqueRuntimeFromEnv().worker;

const startBlogDraftConsumer = async (
  worker: CritiqueWorker,
  outboxRepository: PostgresOutboxRepository,
): Promise<void> => {
  const subject =
    process.env.CRITIQUE_REQUEST_SUBJECT ?? "t.*.blog_draft.v1";

  await startDurableJetStreamConsumer(
    {
      servers: process.env.NATS_SERVERS ?? "nats://localhost:4222",
      streamName: process.env.GROWTHOS_JETSTREAM_STREAM ?? "GROWTHOS",
      subject,
      durableName:
        process.env.CRITIQUE_REQUEST_DURABLE_NAME ?? "growthos_critique",
      queueGroup:
        process.env.CRITIQUE_REQUEST_QUEUE_GROUP ?? "growthos-worker-critique",
      clientName: process.env.NATS_CLIENT_NAME ?? "growthos-worker-critique",
      ackWaitMs: Number(process.env.CRITIQUE_REQUEST_ACK_WAIT_MS ?? "60000"),
      maxDeliver: Number(process.env.CRITIQUE_REQUEST_MAX_DELIVER ?? "5"),
      retryDelayMs: Number(
        process.env.CRITIQUE_REQUEST_RETRY_DELAY_MS ?? "5000",
      ),
      maxAckPending: Number(
        process.env.CRITIQUE_REQUEST_MAX_ACK_PENDING ?? "25",
      ),
    },
    async (payload) => {
      await worker.critique(createBlogDraftCritiqueRequest(payload));
    },
    {
      onError: (error, context) => {
        log.error(
          {
            err: error,
            subject: context.subject,
            sequence: context.streamSequence,
          },
          "blog draft critique processing failed",
        );
      },
      onExhausted: async (payload, context, error) => {
        const tenantId = payload?.tenant_id;
        if (typeof tenantId !== "string") throw error;
        await outboxRepository.enqueue({
          tenantId,
          eventType: "worker.dead_lettered.v1",
          idempotencyKey: `critique:${context.streamSequence}`,
          payload: {
            worker: "critique",
            source_subject: context.subject,
            stream_sequence: context.streamSequence,
            redelivery_count: context.redeliveryCount,
            error: error.message,
            failed_payload: payload,
            occurred_at: new Date().toISOString(),
          },
        });
      },
    },
  );
};

if (process.env.WORKER_BOOTSTRAP === "true") {
  initOtelSdk({ serviceName: "growthos.worker-critique" });
  const { worker, outboxRepository } = createCritiqueRuntimeFromEnv();
  await startBlogDraftConsumer(worker, outboxRepository);
  log.info(
    {
      subject: process.env.CRITIQUE_REQUEST_SUBJECT ?? "t.*.blog_draft.v1",
    },
    "@growthos/worker-critique initialized",
  );
}

export * from "./contracts.js";
export * from "./critique-worker.js";
export * from "./nats-publisher.js";
