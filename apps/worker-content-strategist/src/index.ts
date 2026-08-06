/**
 * worker-content-strategist entry point
 *
 * Subscribes to `t.*.intel_brief.v1` on NATS and delegates each message to
 * ContentStrategistWorker.processBrief().  For each opportunity in the brief,
 * emits ContentOpportunityV1 + ContentBriefV1 to the outbox and NATS.
 *
 * Environment variables:
 *   NATS_SERVERS                     — default nats://localhost:4222
 *   NATS_CLIENT_NAME                 — default growthos-worker-content-strategist
 *   CONTENT_BRIEF_REQUEST_SUBJECT    — override subject pattern
 *   CONTENT_BRIEF_QUEUE_GROUP        — override queue group name
 *   WORKER_BOOTSTRAP                 — set to "true" to start the consumer loop
 *   OTEL_EXPORTER_OTLP_ENDPOINT      — optional OTLP collector endpoint
 *   DATABASE_URL                     — Postgres connection string
 */

import { startDurableJetStreamConsumer } from "@growthos/core";
import { PostgresOutboxRepository, createDbFromEnv } from "@growthos/db";
import { OpenAiLlmCallRunner } from "@growthos/llm-harness";
import { createLogger, initOtelSdk } from "@growthos/observability";
import { ContentStrategistWorker } from "./content-strategist-worker.js";

const log = createLogger("growthos.worker-content-strategist");

export const createContentStrategistWorkerFromEnv =
  async (): Promise<ContentStrategistWorker> => {
    const db = createDbFromEnv();
    const outboxRepository = new PostgresOutboxRepository(db, {
      actorKind: "system",
    });

    return new ContentStrategistWorker({
      outboxRepository,
      ...(process.env.OPENAI_API_KEY
        ? { llmCallRunner: OpenAiLlmCallRunner.fromEnv() }
        : {}),
    });
  };

const startIntelBriefConsumer = async (
  worker: ContentStrategistWorker,
  outboxRepository: PostgresOutboxRepository,
): Promise<void> => {
  const subject =
    process.env.CONTENT_BRIEF_REQUEST_SUBJECT ?? "t.*.intel_brief.v1";
  const queueGroup =
    process.env.CONTENT_BRIEF_QUEUE_GROUP ??
    "growthos-worker-content-strategist";

  await startDurableJetStreamConsumer(
    {
      servers: process.env.NATS_SERVERS ?? "nats://localhost:4222",
      streamName: process.env.GROWTHOS_JETSTREAM_STREAM ?? "GROWTHOS",
      subject,
      durableName:
        process.env.CONTENT_BRIEF_DURABLE_NAME ??
        "growthos_content_strategist",
      queueGroup,
      clientName:
        process.env.NATS_CLIENT_NAME ?? "growthos-worker-content-strategist",
      ackWaitMs: Number(process.env.CONTENT_BRIEF_ACK_WAIT_MS ?? "60000"),
      maxDeliver: Number(process.env.CONTENT_BRIEF_MAX_DELIVER ?? "5"),
      retryDelayMs: Number(process.env.CONTENT_BRIEF_RETRY_DELAY_MS ?? "5000"),
      maxAckPending: Number(
        process.env.CONTENT_BRIEF_MAX_ACK_PENDING ?? "25",
      ),
    },
    async (payload) => {
      await worker.processBrief(payload);
    },
    {
      onError: (error, context) => {
        log.error(
          { err: error, subject: context.subject, sequence: context.streamSequence },
          "content strategist brief processing failed",
        );
      },
      onExhausted: async (payload, context, error) => {
        const tenantId = payload?.tenant_id;
        if (typeof tenantId !== "string") throw error;
        await outboxRepository.enqueue({
          tenantId,
          eventType: "worker.dead_lettered.v1",
          idempotencyKey: `content-strategist:${context.streamSequence}`,
          payload: {
            worker: "content_strategist",
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
  initOtelSdk({ serviceName: "growthos.worker-content-strategist" });
  const db = createDbFromEnv();
  const outboxRepository = new PostgresOutboxRepository(db, {
    actorKind: "system",
  });
  const worker = new ContentStrategistWorker({
    outboxRepository,
    ...(process.env.OPENAI_API_KEY
      ? { llmCallRunner: OpenAiLlmCallRunner.fromEnv() }
      : {}),
  });
  await startIntelBriefConsumer(worker, outboxRepository);
  log.info(
    {
      subject:
        process.env.CONTENT_BRIEF_REQUEST_SUBJECT ?? "t.*.intel_brief.v1",
    },
    "@growthos/worker-content-strategist initialized",
  );
}

export * from "./content-strategist-worker.js";
export * from "./nats-publisher.js";
