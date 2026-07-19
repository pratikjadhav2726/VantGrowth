/**
 * worker-intel-director entry point
 *
 * Subscribes to `t.*.intel_brief.requested.v1` on NATS and delegates each
 * message to IntelDirectorWorker.processBriefRequest().
 *
 * Environment variables:
 *   NATS_SERVERS                  — default nats://localhost:4222
 *   NATS_CLIENT_NAME              — default growthos-worker-intel-director
 *   INTEL_REQUEST_SUBJECT         — override subject pattern
 *   INTEL_REQUEST_QUEUE_GROUP     — override queue group name
 *   WORKER_BOOTSTRAP              — set to "true" to start the consumer loop
 *   OTEL_EXPORTER_OTLP_ENDPOINT   — optional OTLP collector endpoint
 *   DATABASE_URL                  — Postgres connection string
 */

import { startDurableJetStreamConsumer } from "@growthos/core";
import { PostgresOutboxRepository, createDbFromEnv } from "@growthos/db";
import { OpenAiLlmCallRunner } from "@growthos/llm-harness";
import { createLogger, initOtelSdk } from "@growthos/observability";
import { IntelDirectorWorker } from "./intel-director-worker.js";

const log = createLogger("growthos.worker-intel-director");

export const createIntelDirectorWorkerFromEnv =
  async (): Promise<IntelDirectorWorker> => {
    const db = createDbFromEnv();
    const outboxRepository = new PostgresOutboxRepository(db, {
      actorKind: "system",
    });

    return new IntelDirectorWorker({
      outboxRepository,
      ...(process.env.OPENAI_API_KEY
        ? { llmCallRunner: OpenAiLlmCallRunner.fromEnv() }
        : {}),
    });
  };

const startIntelBriefRequestedConsumer = async (
  worker: IntelDirectorWorker,
  outboxRepository: PostgresOutboxRepository,
): Promise<void> => {
  const subject =
    process.env.INTEL_REQUEST_SUBJECT ?? "t.*.intel_brief.requested.v1";
  const queueGroup =
    process.env.INTEL_REQUEST_QUEUE_GROUP ?? "growthos-worker-intel-director";

  await startDurableJetStreamConsumer(
    {
      servers: process.env.NATS_SERVERS ?? "nats://localhost:4222",
      streamName: process.env.GROWTHOS_JETSTREAM_STREAM ?? "GROWTHOS",
      subject,
      durableName:
        process.env.INTEL_REQUEST_DURABLE_NAME ?? "growthos_intel_director",
      queueGroup,
      clientName:
        process.env.NATS_CLIENT_NAME ?? "growthos-worker-intel-director",
      ackWaitMs: Number(process.env.INTEL_REQUEST_ACK_WAIT_MS ?? "60000"),
      maxDeliver: Number(process.env.INTEL_REQUEST_MAX_DELIVER ?? "5"),
      retryDelayMs: Number(process.env.INTEL_REQUEST_RETRY_DELAY_MS ?? "5000"),
      maxAckPending: Number(
        process.env.INTEL_REQUEST_MAX_ACK_PENDING ?? "25",
      ),
    },
    async (payload) => {
      await worker.processBriefRequest(payload);
    },
    {
      onError: (error, context) => {
        log.error(
          { err: error, subject: context.subject, sequence: context.streamSequence },
          "intel brief request processing failed",
        );
      },
      onExhausted: async (payload, context, error) => {
        const tenantId = payload?.tenant_id;
        if (typeof tenantId !== "string") throw error;
        await outboxRepository.enqueue({
          tenantId,
          eventType: "worker.dead_lettered.v1",
          idempotencyKey: `intel-director:${context.streamSequence}`,
          payload: {
            worker: "intel_director",
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
  initOtelSdk({ serviceName: "growthos.worker-intel-director" });
  const db = createDbFromEnv();
  const outboxRepository = new PostgresOutboxRepository(db, {
    actorKind: "system",
  });
  const worker = new IntelDirectorWorker({
    outboxRepository,
    ...(process.env.OPENAI_API_KEY
      ? { llmCallRunner: OpenAiLlmCallRunner.fromEnv() }
      : {}),
  });
  await startIntelBriefRequestedConsumer(worker, outboxRepository);
  log.info(
    {
      subject:
        process.env.INTEL_REQUEST_SUBJECT ?? "t.*.intel_brief.requested.v1",
    },
    "@growthos/worker-intel-director initialized",
  );
}

export * from "./intel-director-worker.js";
export * from "./nats-publisher.js";
