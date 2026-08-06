/**
 * worker-blog-draft entry point
 *
 * Subscribes to `t.*.content_brief.v1` on NATS and delegates each message to
 * BlogDraftWorker.processBrief().  For each ContentBriefV1, generates a
 * BlogDraftV1 skeleton and emits it to the outbox and NATS.
 *
 * Environment variables:
 *   NATS_SERVERS                 — default nats://localhost:4222
 *   NATS_CLIENT_NAME             — default growthos-worker-blog-draft
 *   BLOG_DRAFT_REQUEST_SUBJECT   — override subject pattern
 *   BLOG_DRAFT_QUEUE_GROUP       — override queue group name
 *   WORKER_BOOTSTRAP             — set to "true" to start the consumer loop
 *   OTEL_EXPORTER_OTLP_ENDPOINT  — optional OTLP collector endpoint
 *   DATABASE_URL                 — Postgres connection string
 */

import { startDurableJetStreamConsumer } from "@growthos/core";
import { PostgresOutboxRepository, createDbFromEnv } from "@growthos/db";
import { OpenAiLlmCallRunner } from "@growthos/llm-harness";
import { createLogger, initOtelSdk } from "@growthos/observability";
import { BlogDraftWorker } from "./blog-draft-worker.js";

const log = createLogger("growthos.worker-blog-draft");

export const createBlogDraftWorkerFromEnv =
  async (): Promise<BlogDraftWorker> => {
    const db = createDbFromEnv();
    const outboxRepository = new PostgresOutboxRepository(db, {
      actorKind: "system",
    });
    return new BlogDraftWorker({
      outboxRepository,
      ...(process.env.OPENAI_API_KEY
        ? { llmCallRunner: OpenAiLlmCallRunner.fromEnv() }
        : {}),
    });
  };

const startContentBriefConsumer = async (
  worker: BlogDraftWorker,
  outboxRepository: PostgresOutboxRepository,
): Promise<void> => {
  const subject =
    process.env.BLOG_DRAFT_REQUEST_SUBJECT ?? "t.*.content_brief.v1";
  const queueGroup =
    process.env.BLOG_DRAFT_QUEUE_GROUP ?? "growthos-worker-blog-draft";

  await startDurableJetStreamConsumer(
    {
      servers: process.env.NATS_SERVERS ?? "nats://localhost:4222",
      streamName: process.env.GROWTHOS_JETSTREAM_STREAM ?? "GROWTHOS",
      subject,
      durableName:
        process.env.BLOG_DRAFT_DURABLE_NAME ?? "growthos_blog_draft",
      queueGroup,
      clientName: process.env.NATS_CLIENT_NAME ?? "growthos-worker-blog-draft",
      ackWaitMs: Number(process.env.BLOG_DRAFT_ACK_WAIT_MS ?? "60000"),
      maxDeliver: Number(process.env.BLOG_DRAFT_MAX_DELIVER ?? "5"),
      retryDelayMs: Number(process.env.BLOG_DRAFT_RETRY_DELAY_MS ?? "5000"),
      maxAckPending: Number(
        process.env.BLOG_DRAFT_MAX_ACK_PENDING ?? "25",
      ),
    },
    async (payload) => {
      await worker.processBrief(payload);
    },
    {
      onError: (error, context) => {
        log.error(
          { err: error, subject: context.subject, sequence: context.streamSequence },
          "blog draft processing failed",
        );
      },
      onExhausted: async (payload, context, error) => {
        const tenantId = payload?.tenant_id;
        if (typeof tenantId !== "string") throw error;
        await outboxRepository.enqueue({
          tenantId,
          eventType: "worker.dead_lettered.v1",
          idempotencyKey: `blog-draft:${context.streamSequence}`,
          payload: {
            worker: "blog_draft",
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
  initOtelSdk({ serviceName: "growthos.worker-blog-draft" });
  const db = createDbFromEnv();
  const outboxRepository = new PostgresOutboxRepository(db, {
    actorKind: "system",
  });
  const worker = new BlogDraftWorker({
    outboxRepository,
    ...(process.env.OPENAI_API_KEY
      ? { llmCallRunner: OpenAiLlmCallRunner.fromEnv() }
      : {}),
  });
  await startContentBriefConsumer(worker, outboxRepository);
  log.info(
    {
      subject: process.env.BLOG_DRAFT_REQUEST_SUBJECT ?? "t.*.content_brief.v1",
    },
    "@growthos/worker-blog-draft initialized",
  );
}

export * from "./blog-draft-worker.js";
export * from "./nats-publisher.js";
