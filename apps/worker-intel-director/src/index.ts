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

import { PostgresOutboxRepository, createDbFromEnv } from "@growthos/db";
import { createLogger, initOtelSdk } from "@growthos/observability";
import { JSONCodec, connect } from "nats";
import { IntelDirectorWorker } from "./intel-director-worker.js";
import { NatsJetStreamPublisher } from "./nats-publisher.js";

const log = createLogger("growthos.worker-intel-director");

export const createIntelDirectorWorkerFromEnv =
  async (): Promise<IntelDirectorWorker> => {
    const db = createDbFromEnv();
    const outboxRepository = new PostgresOutboxRepository(db, {
      actorKind: "system",
    });
    const eventPublisher = await NatsJetStreamPublisher.connect();

    return new IntelDirectorWorker({ outboxRepository, eventPublisher });
  };

const startIntelBriefRequestedConsumer = async (
  worker: IntelDirectorWorker,
): Promise<void> => {
  const connection = await connect({
    servers: process.env.NATS_SERVERS ?? "nats://localhost:4222",
    name:
      process.env.NATS_CLIENT_NAME ?? "growthos-worker-intel-director-consumer",
  });

  const codec = JSONCodec<Record<string, unknown>>();
  const subject =
    process.env.INTEL_REQUEST_SUBJECT ?? "t.*.intel_brief.requested.v1";
  const queueGroup =
    process.env.INTEL_REQUEST_QUEUE_GROUP ?? "growthos-worker-intel-director";

  const subscription = connection.subscribe(subject, { queue: queueGroup });

  void (async () => {
    for await (const message of subscription) {
      try {
        await worker.processBriefRequest(codec.decode(message.data));
      } catch (error) {
        log.error({ err: error }, "intel brief request processing failed");
      }
    }
  })();
};

if (process.env.WORKER_BOOTSTRAP === "true") {
  initOtelSdk({ serviceName: "growthos.worker-intel-director" });
  const worker = await createIntelDirectorWorkerFromEnv();
  await startIntelBriefRequestedConsumer(worker);
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
