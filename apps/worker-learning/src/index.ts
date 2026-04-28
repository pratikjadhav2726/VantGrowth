import { PostgresOutboxRepository, createDbFromEnv } from "@growthos/db";
import { createLogger, initOtelSdk } from "@growthos/observability";
import { LearningWorker } from "./learning-worker.js";
import { NatsJetStreamPublisher } from "./nats-publisher.js";

const log = createLogger("growthos.worker-learning");

export const createLearningWorkerFromEnv =
  async (): Promise<LearningWorker> => {
    const outboxRepository = new PostgresOutboxRepository(createDbFromEnv(), {
      actorKind: "system",
    });
    const eventPublisher = await NatsJetStreamPublisher.connect();

    return new LearningWorker({
      outboxRepository,
      eventPublisher,
    });
  };

if (process.env.WORKER_BOOTSTRAP === "true") {
  initOtelSdk({ serviceName: "growthos.worker-learning" });
  await createLearningWorkerFromEnv();
  log.info("@growthos/worker-learning initialized");
}

export * from "./contracts.js";
export * from "./learning-worker.js";
export * from "./nats-publisher.js";
