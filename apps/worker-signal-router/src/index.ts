import { PostgresOutboxRepository, createPgPoolFromEnv } from "@growthos/db";
import { NatsJetStreamPublisher } from "./nats-publisher.js";
import { SignalRouter } from "./signal-router.js";

export const createSignalRouterFromEnv = async (): Promise<SignalRouter> => {
  const outboxRepository = new PostgresOutboxRepository(createPgPoolFromEnv(), {
    actorKind: "system"
  });
  const eventPublisher = await NatsJetStreamPublisher.connect();

  return new SignalRouter({
    outboxRepository,
    eventPublisher
  });
};

if (process.env.WORKER_BOOTSTRAP === "true") {
  await createSignalRouterFromEnv();
  console.log("@growthos/worker-signal-router initialized");
}

export * from "./contracts.js";
export * from "./nats-publisher.js";
export * from "./signal-router.js";
