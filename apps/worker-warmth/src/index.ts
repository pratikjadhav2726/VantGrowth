import { PostgresOutboxRepository, createDbFromEnv } from "@growthos/db";
import { createLogger, initOtelSdk } from "@growthos/observability";
import { NatsJetStreamPublisher } from "./nats-publisher.js";
import { WarmthWorker } from "./warmth-worker.js";

const log = createLogger("growthos.worker-warmth");

export const createWarmthWorkerFromEnv = async (): Promise<WarmthWorker> => {
  const outboxRepository = new PostgresOutboxRepository(createDbFromEnv(), {
    actorKind: "system",
  });
  const eventPublisher = await NatsJetStreamPublisher.connect();

  return new WarmthWorker({
    outboxRepository,
    eventPublisher,
  });
};

if (process.env.WORKER_BOOTSTRAP === "true") {
  initOtelSdk({ serviceName: "growthos.worker-warmth" });
  await createWarmthWorkerFromEnv();
  log.info("@growthos/worker-warmth initialized");
}

export * from "./contracts.js";
export * from "./nats-publisher.js";
export * from "./warmth-worker.js";
