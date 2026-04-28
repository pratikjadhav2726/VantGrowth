import { PostgresOutboxRepository, createPgPoolFromEnv } from "@growthos/db";
import {
  PostgresCycleLeaseGuard,
  cycleLeaseConfigFromEnv,
} from "./cycle-lease.js";
import { NatsJetStreamPublisher } from "./nats-publisher.js";
import { PostgresOutboxNotifier } from "./outbox-notifier.js";
import { OutboxPublisher, runtimeConfigFromEnv } from "./outbox-publisher.js";
import { OutboxPublisherRunner } from "./runner.js";

export const createOutboxPublisherFromEnv = async (): Promise<{
  publisher: OutboxPublisher;
  runtimeConfig: ReturnType<typeof runtimeConfigFromEnv>;
  close: () => Promise<void>;
}> => {
  const outboxRepository = new PostgresOutboxRepository(createPgPoolFromEnv(), {
    actorKind: "system",
  });
  const eventPublisher = await NatsJetStreamPublisher.connect();
  const publisher = new OutboxPublisher({
    outboxRepository,
    eventPublisher,
  });
  const runtimeConfig = runtimeConfigFromEnv();

  return {
    publisher,
    runtimeConfig,
    close: () => eventPublisher.close(),
  };
};

export const startOutboxPublisherLoop = (
  publisher: OutboxPublisher,
  runtimeConfig: ReturnType<typeof runtimeConfigFromEnv>,
  options: {
    leaseGuard?: PostgresCycleLeaseGuard;
    notifier?: PostgresOutboxNotifier | null;
  } = {},
): OutboxPublisherRunner => {
  const runnerOptions = {
    onCycleError: (error: unknown) => {
      console.error("outbox publish cycle failed", error);
    },
    ...(options.leaseGuard ? { leaseGuard: options.leaseGuard } : {}),
  };
  const runner = new OutboxPublisherRunner(
    publisher,
    runtimeConfig,
    runnerOptions,
  );
  runner.start();
  if (options.notifier) {
    void options.notifier.start((tenantId) => {
      if (tenantId && !runtimeConfig.tenantIds.includes(tenantId)) return;
      void runner.runCycle();
    });
  }
  return runner;
};

if (process.env.WORKER_BOOTSTRAP === "true") {
  const { publisher, runtimeConfig } = await createOutboxPublisherFromEnv();
  const leaseGuard = new PostgresCycleLeaseGuard(
    createPgPoolFromEnv(),
    cycleLeaseConfigFromEnv(),
  );
  const notifier =
    process.env.OUTBOX_ENABLE_LISTEN_NOTIFY === "false"
      ? null
      : PostgresOutboxNotifier.fromEnv();
  startOutboxPublisherLoop(publisher, runtimeConfig, {
    leaseGuard,
    notifier,
  });
  console.log("@growthos/worker-outbox-publisher initialized");
}

export * from "./cycle-lease.js";
export * from "./nats-publisher.js";
export * from "./outbox-notifier.js";
export * from "./outbox-publisher.js";
export * from "./runner.js";
