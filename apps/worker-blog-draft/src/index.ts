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

import { PostgresOutboxRepository, createDbFromEnv } from "@growthos/db";
import { createLogger, initOtelSdk } from "@growthos/observability";
import { JSONCodec, connect } from "nats";
import { BlogDraftWorker } from "./blog-draft-worker.js";
import { NatsJetStreamPublisher } from "./nats-publisher.js";

const log = createLogger("growthos.worker-blog-draft");

export const createBlogDraftWorkerFromEnv =
  async (): Promise<BlogDraftWorker> => {
    const db = createDbFromEnv();
    const outboxRepository = new PostgresOutboxRepository(db, {
      actorKind: "system",
    });
    const eventPublisher = await NatsJetStreamPublisher.connect();
    return new BlogDraftWorker({ outboxRepository, eventPublisher });
  };

const startContentBriefConsumer = async (
  worker: BlogDraftWorker,
): Promise<void> => {
  const connection = await connect({
    servers: process.env.NATS_SERVERS ?? "nats://localhost:4222",
    name: process.env.NATS_CLIENT_NAME ?? "growthos-worker-blog-draft-consumer",
  });

  const codec = JSONCodec<Record<string, unknown>>();
  const subject =
    process.env.BLOG_DRAFT_REQUEST_SUBJECT ?? "t.*.content_brief.v1";
  const queueGroup =
    process.env.BLOG_DRAFT_QUEUE_GROUP ?? "growthos-worker-blog-draft";

  const subscription = connection.subscribe(subject, { queue: queueGroup });

  void (async () => {
    for await (const message of subscription) {
      try {
        await worker.processBrief(codec.decode(message.data));
      } catch (error) {
        log.error({ err: error }, "blog draft worker brief processing failed");
      }
    }
  })();
};

if (process.env.WORKER_BOOTSTRAP === "true") {
  initOtelSdk({ serviceName: "growthos.worker-blog-draft" });
  const worker = await createBlogDraftWorkerFromEnv();
  await startContentBriefConsumer(worker);
  log.info(
    {
      subject: process.env.BLOG_DRAFT_REQUEST_SUBJECT ?? "t.*.content_brief.v1",
    },
    "@growthos/worker-blog-draft initialized",
  );
}

export * from "./blog-draft-worker.js";
export * from "./nats-publisher.js";
