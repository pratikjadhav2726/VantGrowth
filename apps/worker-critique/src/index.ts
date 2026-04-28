import { PostgresOutboxRepository, createDbFromEnv } from "@growthos/db";
import { createLogger, initOtelSdk } from "@growthos/observability";
import { CritiqueWorker } from "./critique-worker.js";
import { NatsJetStreamPublisher } from "./nats-publisher.js";

const log = createLogger("growthos.worker-critique");

export const createCritiqueWorkerFromEnv =
  async (): Promise<CritiqueWorker> => {
    const outboxRepository = new PostgresOutboxRepository(createDbFromEnv(), {
      actorKind: "system",
    });
    const eventPublisher = await NatsJetStreamPublisher.connect();

    return new CritiqueWorker({
      outboxRepository,
      eventPublisher,
    });
  };

if (process.env.WORKER_BOOTSTRAP === "true") {
  initOtelSdk({ serviceName: "growthos.worker-critique" });
  await createCritiqueWorkerFromEnv();
  log.info("@growthos/worker-critique initialized");
}

export * from "./contracts.js";
export * from "./critique-worker.js";
export * from "./nats-publisher.js";
