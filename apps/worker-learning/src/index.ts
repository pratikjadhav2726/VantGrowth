import {
  PostgresOutboxRepository,
  PostgresPlaybookVersionsRepository,
  createDbFromEnv,
} from "@growthos/db";
import { createLogger, initOtelSdk } from "@growthos/observability";
import { StringCodec } from "nats";
import { LearningWorker } from "./learning-worker.js";
import { NatsJetStreamPublisher } from "./nats-publisher.js";

const log = createLogger("growthos.worker-learning");

export const createLearningWorkerFromEnv =
  async (): Promise<LearningWorker> => {
    const db = createDbFromEnv();
    const outboxRepository = new PostgresOutboxRepository(db, {
      actorKind: "system",
    });
    const eventPublisher = await NatsJetStreamPublisher.connect();
    const playbookRepository = new PostgresPlaybookVersionsRepository(db);

    return new LearningWorker({
      outboxRepository,
      eventPublisher,
      playbookRepository,
    });
  };

if (process.env.WORKER_BOOTSTRAP === "true") {
  initOtelSdk({ serviceName: "growthos.worker-learning" });

  const nc = await NatsJetStreamPublisher.connectRaw();
  const sc = StringCodec();
  const worker = await createLearningWorkerFromEnv();

  log.info("@growthos/worker-learning initialized");

  // ── Consume approval_feedback learning signals ──────────────────────────
  nc.subscribe("t.*.learning.signal.v1", {
    queue: "worker-learning",
    callback: (err, msg) => {
      if (err) {
        log.error({ err }, "NATS subscription error on learning.signal.v1");
        return;
      }
      const raw = JSON.parse(sc.decode(msg.data)) as Record<string, unknown>;
      worker
        .process(raw as Parameters<typeof worker.process>[0])
        .catch((e: unknown) => {
          log.error({ err: e }, "LearningWorker.process failed");
        });
    },
  });

  // ── Consume critique.completed.v1 — playbook feedback loop ──────────────
  nc.subscribe("t.*.critique.completed.v1", {
    queue: "worker-learning-critique",
    callback: (err, msg) => {
      if (err) {
        log.error({ err }, "NATS subscription error on critique.completed.v1");
        return;
      }
      const subject = msg.subject; // "t.<tenantId>.critique.completed.v1"
      const parts = subject.split(".");
      const tenantId = parts[1] ?? "";
      const raw = JSON.parse(sc.decode(msg.data)) as unknown;
      worker.processFromCritique(tenantId, raw).catch((e: unknown) => {
        log.error(
          { err: e, tenantId },
          "LearningWorker.processFromCritique failed",
        );
      });
    },
  });
}

export * from "./contracts.js";
export * from "./learning-worker.js";
export * from "./nats-publisher.js";
