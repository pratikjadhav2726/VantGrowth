import { PaperclipClient } from "@growthos/adapter";
import { createLogger, initOtelSdk } from "@growthos/observability";
import { configFromEnv } from "./config.js";
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
    return new PaperclipHeartbeatWorker({ client, config, logger: log });
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
export * from "./paperclip-heartbeat-worker.js";
