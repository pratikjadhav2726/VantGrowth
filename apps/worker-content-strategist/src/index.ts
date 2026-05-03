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

import { PostgresOutboxRepository, createDbFromEnv } from "@growthos/db";
import { createLogger, initOtelSdk } from "@growthos/observability";
import { JSONCodec, connect } from "nats";
import { ContentStrategistWorker } from "./content-strategist-worker.js";
import { NatsJetStreamPublisher } from "./nats-publisher.js";

const log = createLogger("growthos.worker-content-strategist");

export const createContentStrategistWorkerFromEnv =
  async (): Promise<ContentStrategistWorker> => {
    const db = createDbFromEnv();
    const outboxRepository = new PostgresOutboxRepository(db, {
      actorKind: "system",
    });
    const eventPublisher = await NatsJetStreamPublisher.connect();

    return new ContentStrategistWorker({ outboxRepository, eventPublisher });
  };

const startIntelBriefConsumer = async (
  worker: ContentStrategistWorker,
): Promise<void> => {
  const connection = await connect({
    servers: process.env.NATS_SERVERS ?? "nats://localhost:4222",
    name:
      process.env.NATS_CLIENT_NAME ??
      "growthos-worker-content-strategist-consumer",
  });

  const codec = JSONCodec<Record<string, unknown>>();
  const subject =
    process.env.CONTENT_BRIEF_REQUEST_SUBJECT ?? "t.*.intel_brief.v1";
  const queueGroup =
    process.env.CONTENT_BRIEF_QUEUE_GROUP ??
    "growthos-worker-content-strategist";

  const subscription = connection.subscribe(subject, { queue: queueGroup });

  void (async () => {
    for await (const message of subscription) {
      try {
        await worker.processBrief(codec.decode(message.data));
      } catch (error) {
        log.error({ err: error }, "content strategist brief processing failed");
      }
    }
  })();
};

if (process.env.WORKER_BOOTSTRAP === "true") {
  initOtelSdk({ serviceName: "growthos.worker-content-strategist" });
  const worker = await createContentStrategistWorkerFromEnv();
  await startIntelBriefConsumer(worker);
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
