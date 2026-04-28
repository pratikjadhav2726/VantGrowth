import { PostgresOutboxRepository, createDbFromEnv } from "@growthos/db";
import { AttributionWorker } from "./attribution-worker.js";
import { NatsJetStreamPublisher } from "./nats-publisher.js";

export const createAttributionWorkerFromEnv =
  async (): Promise<AttributionWorker> => {
    const outboxRepository = new PostgresOutboxRepository(
      createDbFromEnv(),
      {
        actorKind: "system",
      },
    );
    const eventPublisher = await NatsJetStreamPublisher.connect();

    return new AttributionWorker({
      outboxRepository,
      eventPublisher,
    });
  };

if (process.env.WORKER_BOOTSTRAP === "true") {
  await createAttributionWorkerFromEnv();
  console.log("@growthos/worker-attribution initialized");
}

export * from "./attribution-worker.js";
export * from "./contracts.js";
export * from "./nats-publisher.js";
