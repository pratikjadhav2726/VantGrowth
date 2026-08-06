import { PaperclipClient } from "@growthos/adapter";
import { PostgresOutboxRepository, createDbFromEnv } from "@growthos/db";
import { createLogger, initOtelSdk } from "@growthos/observability";
import { configFromEnv } from "./config.js";
import { OutboxPaperclipWorkDispatcher } from "./outbox-paperclip-work-dispatcher.js";
import { PaperclipHeartbeatWorker } from "./paperclip-heartbeat-worker.js";

const log = createLogger("growthos.worker-paperclip-heartbeat");

export const createPaperclipHeartbeatWorkerFromEnv =
  (): PaperclipHeartbeatWorker => {
    const config = configFromEnv();
    const client = new PaperclipClient({
      baseUrl: config.paperclip.baseUrl,
      serviceToken: config.paperclip.serviceToken,
      timeoutMs: config.paperclip.timeoutMs,
    });

    // A dry-run is intentionally operable without database credentials; it
    // only inspects Paperclip. Live mode always constructs the durable outbox
    // dispatcher and therefore fails fast if DATABASE_URL is missing.
    const dispatch = config.dryRun
      ? undefined
      : new OutboxPaperclipWorkDispatcher(
          new PostgresOutboxRepository(createDbFromEnv(), {
            actorKind: "system",
          }),
        ).asDispatcher();

    return new PaperclipHeartbeatWorker({
      client,
      config,
      logger: log,
      ...(dispatch ? { dispatch } : {}),
    });
  };

if (process.env.WORKER_BOOTSTRAP === "true") {
  initOtelSdk({ serviceName: "growthos.worker-paperclip-heartbeat" });
  const worker = createPaperclipHeartbeatWorkerFromEnv();
  worker.start();
  log.info("@growthos/worker-paperclip-heartbeat initialized");

  const shutdown = (signal: string) => {
    log.info({ signal }, "shutting down paperclip-heartbeat worker");
    worker.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

export * from "./config.js";
export * from "./outbox-paperclip-work-dispatcher.js";
export * from "./paperclip-heartbeat-worker.js";
