import { PostgresOutboxRepository, createPgPoolFromEnv } from "@growthos/db";
import { LearningWorker } from "./learning-worker.js";
import { NatsJetStreamPublisher } from "./nats-publisher.js";

export const createLearningWorkerFromEnv =
  async (): Promise<LearningWorker> => {
    const outboxRepository = new PostgresOutboxRepository(
      createPgPoolFromEnv(),
      {
        actorKind: "system",
      },
    );
    const eventPublisher = await NatsJetStreamPublisher.connect();

    return new LearningWorker({
      outboxRepository,
      eventPublisher,
    });
  };

if (process.env.WORKER_BOOTSTRAP === "true") {
  await createLearningWorkerFromEnv();
  console.log("@growthos/worker-learning initialized");
}

export * from "./contracts.js";
export * from "./learning-worker.js";
export * from "./nats-publisher.js";
