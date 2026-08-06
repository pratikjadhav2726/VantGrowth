/**
 * Durable warmth evaluation worker.
 *
 * `warmth.signal.v1` events cross the Postgres outbox before JetStream. A
 * message is acknowledged only after the evaluation result is durable.
 */

import { startDurableJetStreamConsumer } from "@growthos/core";
import {
  type OutboxRepository,
  PostgresOutboxRepository,
  createDbFromEnv,
} from "@growthos/db";
import { createLogger, initOtelSdk } from "@growthos/observability";
import { z } from "zod";
import { parseWarmthSignalEvent } from "./contracts.js";
import { WarmthWorker } from "./warmth-worker.js";

const log = createLogger("growthos.worker-warmth");

interface WarmthRuntime {
  worker: WarmthWorker;
  outboxRepository: PostgresOutboxRepository;
}

const createWarmthRuntimeFromEnv = (): WarmthRuntime => {
  const db = createDbFromEnv();
  const outboxRepository = new PostgresOutboxRepository(db, {
    actorKind: "system",
  });

  return {
    outboxRepository,
    worker: new WarmthWorker({ outboxRepository }),
  };
};

export const createWarmthWorkerFromEnv = async (): Promise<WarmthWorker> =>
  createWarmthRuntimeFromEnv().worker;

const tenantIdFromSubject = (subject: string): string => {
  const [scope, tenantId] = subject.split(".");
  if (scope !== "t" || !tenantId) {
    throw new Error(`Invalid tenant-scoped event subject: ${subject}`);
  }

  return z.string().uuid().parse(tenantId);
};

const enqueueDeadLetter = async (
  outboxRepository: OutboxRepository,
  payload: Record<string, unknown> | null,
  context: {
    subject: string;
    streamSequence: number;
    redeliveryCount: number;
  },
  error: Error,
): Promise<void> => {
  await outboxRepository.enqueue({
    tenantId: tenantIdFromSubject(context.subject),
    eventType: "worker.dead_lettered.v1",
    idempotencyKey: `warmth:${context.streamSequence}`,
    payload: {
      worker: "warmth",
      source_subject: context.subject,
      stream_sequence: context.streamSequence,
      redelivery_count: context.redeliveryCount,
      error: error.message,
      failed_payload: payload ?? {},
      occurred_at: new Date().toISOString(),
    },
  });
};

export const startWarmthSignalConsumer = async (
  worker: WarmthWorker,
  outboxRepository: OutboxRepository,
): Promise<void> => {
  const subject = process.env.WARMTH_SIGNAL_SUBJECT ?? "t.*.warmth.signal.v1";

  await startDurableJetStreamConsumer(
    {
      servers: process.env.NATS_SERVERS ?? "nats://localhost:4222",
      streamName: process.env.GROWTHOS_JETSTREAM_STREAM ?? "GROWTHOS",
      subject,
      durableName: process.env.WARMTH_SIGNAL_DURABLE_NAME ?? "growthos_warmth",
      queueGroup:
        process.env.WARMTH_SIGNAL_QUEUE_GROUP ?? "growthos-worker-warmth",
      clientName: process.env.NATS_CLIENT_NAME ?? "growthos-worker-warmth",
      ackWaitMs: Number(process.env.WARMTH_SIGNAL_ACK_WAIT_MS ?? "60000"),
      maxDeliver: Number(process.env.WARMTH_SIGNAL_MAX_DELIVER ?? "5"),
      retryDelayMs: Number(process.env.WARMTH_SIGNAL_RETRY_DELAY_MS ?? "5000"),
      maxAckPending: Number(process.env.WARMTH_SIGNAL_MAX_ACK_PENDING ?? "25"),
    },
    async (payload, context) => {
      const tenantId = tenantIdFromSubject(context.subject);
      await worker.process(parseWarmthSignalEvent(payload, tenantId));
    },
    {
      onError: (error, context) => {
        log.error(
          {
            err: error,
            subject: context.subject,
            sequence: context.streamSequence,
          },
          "warmth signal processing failed",
        );
      },
      onExhausted: async (payload, context, error) =>
        enqueueDeadLetter(outboxRepository, payload, context, error),
    },
  );
};

if (process.env.WORKER_BOOTSTRAP === "true") {
  initOtelSdk({ serviceName: "growthos.worker-warmth" });
  const { worker, outboxRepository } = createWarmthRuntimeFromEnv();
  await startWarmthSignalConsumer(worker, outboxRepository);
  log.info(
    {
      subject: process.env.WARMTH_SIGNAL_SUBJECT ?? "t.*.warmth.signal.v1",
    },
    "@growthos/worker-warmth initialized",
  );
}

export * from "./contracts.js";
export * from "./warmth-worker.js";
