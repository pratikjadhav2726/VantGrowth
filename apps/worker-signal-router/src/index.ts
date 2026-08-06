import {
  PostgresOutboxRepository,
  PostgresSignalEventsRepository,
  createDbFromEnv,
} from "@growthos/db";
import { createLogger, initOtelSdk } from "@growthos/observability";
import {
  SignalIngestionWorker,
  signalRouterRuntimeConfigFromEnv,
} from "./signal-ingestion-worker.js";
import { SignalRouter } from "./signal-router.js";

const log = createLogger("growthos.worker-signal-router");

export const createSignalRouterFromEnv = async (): Promise<SignalRouter> => {
  const outboxRepository = new PostgresOutboxRepository(createDbFromEnv(), {
    actorKind: "system",
  });

  return new SignalRouter({
    outboxRepository,
  });
};

export interface SignalRouterRuntime {
  start(): void;
  stop(): void;
  tick(): Promise<void>;
}

export const createSignalRouterRuntimeFromEnv = async (): Promise<SignalRouterRuntime> => {
  const db = createDbFromEnv();
  const outboxRepository = new PostgresOutboxRepository(db, {
    actorKind: "system",
  });
  const signalEventsRepository = new PostgresSignalEventsRepository(db);
  const signalRouter = new SignalRouter({ outboxRepository });
  const config = signalRouterRuntimeConfigFromEnv();
  const worker = new SignalIngestionWorker({
    signalEventsRepository,
    outboxRepository,
    signalRouter,
    claimOwner:
      process.env.SIGNAL_ROUTER_CLAIM_OWNER ??
      `signal-router:${process.pid}:${crypto.randomUUID()}`,
    claimLeaseMs: config.claimLeaseMs,
  });
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;

  const tick = async (): Promise<void> => {
    if (ticking) return;
    ticking = true;
    try {
      for (const tenantId of config.tenantIds) {
        const result = await worker.processTenant(
          tenantId,
          config.batchSizePerSignalType,
        );
        for (const failure of result.failures) {
          log.error(
            {
              tenant_id: tenantId,
              signal_id: failure.signalId,
              err: failure.error,
            },
            "signal routing failed; signal remains in durable inbox for retry",
          );
        }
        if (result.processedSignalIds.length > 0) {
          log.info(
            {
              tenant_id: tenantId,
              processed_signal_count: result.processedSignalIds.length,
            },
            "processed durable signal inbox batch",
          );
        }
      }
    } finally {
      ticking = false;
    }
  };

  return {
    start(): void {
      if (timer) return;
      void tick();
      timer = setInterval(() => void tick(), config.pollIntervalMs);
    },
    stop(): void {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    tick,
  };
};

if (process.env.WORKER_BOOTSTRAP === "true") {
  initOtelSdk({ serviceName: "growthos.worker-signal-router" });
  const runtime = await createSignalRouterRuntimeFromEnv();
  runtime.start();
  log.info("@growthos/worker-signal-router initialized with durable inbox polling");

  const shutdown = (signal: string) => {
    runtime.stop();
    log.info({ signal }, "signal-router worker stopped");
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

export * from "./contracts.js";
export * from "./signal-ingestion-worker.js";
export * from "./nats-publisher.js";
export * from "./signal-router.js";
