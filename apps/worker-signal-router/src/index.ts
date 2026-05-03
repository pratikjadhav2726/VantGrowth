import { PostgresOutboxRepository, createDbFromEnv } from "@growthos/db";
import { createLogger, initOtelSdk } from "@growthos/observability";
import { NatsJetStreamPublisher } from "./nats-publisher.js";
import { SignalRouter } from "./signal-router.js";

const log = createLogger("growthos.worker-signal-router");

export const createSignalRouterFromEnv = async (): Promise<SignalRouter> => {
  const outboxRepository = new PostgresOutboxRepository(createDbFromEnv(), {
    actorKind: "system",
  });
  const eventPublisher = await NatsJetStreamPublisher.connect();

  return new SignalRouter({
    outboxRepository,
    eventPublisher,
  });
};

if (process.env.WORKER_BOOTSTRAP === "true") {
  initOtelSdk({ serviceName: "growthos.worker-signal-router" });
  await createSignalRouterFromEnv();
  log.info("@growthos/worker-signal-router initialized");
}

export * from "./contracts.js";
export * from "./nats-publisher.js";
export * from "./signal-router.js";
