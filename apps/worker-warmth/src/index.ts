import { PostgresOutboxRepository, createDbFromEnv } from "@growthos/db";
import { NatsJetStreamPublisher } from "./nats-publisher.js";
import { WarmthWorker } from "./warmth-worker.js";

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
  await createWarmthWorkerFromEnv();
  console.log("@growthos/worker-warmth initialized");
}

export * from "./contracts.js";
export * from "./nats-publisher.js";
export * from "./warmth-worker.js";
