import { PostgresOutboxRepository, createDbFromEnv } from "@growthos/db";
import { N8nDispatchClient } from "@growthos/n8n";
import { createLogger, initOtelSdk } from "@growthos/observability";
import {
  PostgresCycleLeaseGuard,
  cycleLeaseConfigFromEnv,
} from "./cycle-lease.js";
import { NatsJetStreamPublisher } from "./nats-publisher.js";
import { PostgresOutboxNotifier } from "./outbox-notifier.js";
import { OutboxPublisher, runtimeConfigFromEnv } from "./outbox-publisher.js";
import { OutboxPublisherRunner } from "./runner.js";

const log = createLogger("growthos.worker-outbox-publisher");

const resolveN8nDispatchClient = (): N8nDispatchClient | null => {
  const webhookUrl = process.env.N8N_DISPATCH_WEBHOOK_URL;
  if (!webhookUrl) return null;

  const configuredTimeoutMs = process.env.N8N_TIMEOUT_MS
    ? Number(process.env.N8N_TIMEOUT_MS)
    : 10_000;

  return new N8nDispatchClient({
    webhookUrl,
    timeoutMs:
      Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
        ? configuredTimeoutMs
        : 10_000,
  });
};

export const createOutboxPublisherFromEnv = async (): Promise<{
  publisher: OutboxPublisher;
  runtimeConfig: ReturnType<typeof runtimeConfigFromEnv>;
  close: () => Promise<void>;
}> => {
  const outboxRepository = new PostgresOutboxRepository(createDbFromEnv(), {
    actorKind: "system",
  });
  const eventPublisher = await NatsJetStreamPublisher.connect();
  const publisher = new OutboxPublisher({
    outboxRepository,
    eventPublisher,
    n8nDispatchClient: resolveN8nDispatchClient(),
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
      log.error({ err: error }, "outbox publish cycle failed");
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
  initOtelSdk({ serviceName: "growthos.worker-outbox-publisher" });
  const { publisher, runtimeConfig } = await createOutboxPublisherFromEnv();
  const leaseGuard = new PostgresCycleLeaseGuard(
    createDbFromEnv(),
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
  log.info(
    {
      tenantIds: runtimeConfig.tenantIds,
      pollIntervalMs: runtimeConfig.pollIntervalMs,
      batchSizePerTenant: runtimeConfig.batchSizePerTenant,
      listenNotify: process.env.OUTBOX_ENABLE_LISTEN_NOTIFY !== "false",
    },
    "@growthos/worker-outbox-publisher initialized",
  );
}

export * from "./cycle-lease.js";
export * from "./nats-publisher.js";
export * from "./outbox-notifier.js";
export * from "./outbox-publisher.js";
export * from "./runner.js";
