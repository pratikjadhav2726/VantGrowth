/**
 * Durable attribution rollup worker.
 *
 * `attribution.signal.v1` events are written to Postgres first and published
 * by the outbox publisher. This worker acknowledges a JetStream message only
 * after its rollup event has been written back to the outbox.
 */

import { startDurableJetStreamConsumer } from "@growthos/core";
import {
  type OutboxRepository,
  PostgresOutboxRepository,
  createDbFromEnv,
} from "@growthos/db";
import { createLogger, initOtelSdk } from "@growthos/observability";
import { z } from "zod";
import { AttributionWorker } from "./attribution-worker.js";
import { parseAttributionSignalEvent } from "./contracts.js";

const log = createLogger("growthos.worker-attribution");

interface AttributionRuntime {
  worker: AttributionWorker;
  outboxRepository: PostgresOutboxRepository;
}

const createAttributionRuntimeFromEnv = (): AttributionRuntime => {
  const db = createDbFromEnv();
  const outboxRepository = new PostgresOutboxRepository(db, {
    actorKind: "system",
  });

  return {
    outboxRepository,
    worker: new AttributionWorker({ outboxRepository }),
  };
};

export const createAttributionWorkerFromEnv =
  async (): Promise<AttributionWorker> =>
    createAttributionRuntimeFromEnv().worker;

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
    idempotencyKey: `attribution:${context.streamSequence}`,
    payload: {
      worker: "attribution",
      source_subject: context.subject,
      stream_sequence: context.streamSequence,
      redelivery_count: context.redeliveryCount,
      error: error.message,
      failed_payload: payload ?? {},
      occurred_at: new Date().toISOString(),
    },
  });
};

export const startAttributionSignalConsumer = async (
  worker: AttributionWorker,
  outboxRepository: OutboxRepository,
): Promise<void> => {
  const subject =
    process.env.ATTRIBUTION_SIGNAL_SUBJECT ?? "t.*.attribution.signal.v1";

  await startDurableJetStreamConsumer(
    {
      servers: process.env.NATS_SERVERS ?? "nats://localhost:4222",
      streamName: process.env.GROWTHOS_JETSTREAM_STREAM ?? "GROWTHOS",
      subject,
      durableName:
        process.env.ATTRIBUTION_SIGNAL_DURABLE_NAME ?? "growthos_attribution",
      queueGroup:
        process.env.ATTRIBUTION_SIGNAL_QUEUE_GROUP ??
        "growthos-worker-attribution",
      clientName: process.env.NATS_CLIENT_NAME ?? "growthos-worker-attribution",
      ackWaitMs: Number(process.env.ATTRIBUTION_SIGNAL_ACK_WAIT_MS ?? "60000"),
      maxDeliver: Number(process.env.ATTRIBUTION_SIGNAL_MAX_DELIVER ?? "5"),
      retryDelayMs: Number(
        process.env.ATTRIBUTION_SIGNAL_RETRY_DELAY_MS ?? "5000",
      ),
      maxAckPending: Number(
        process.env.ATTRIBUTION_SIGNAL_MAX_ACK_PENDING ?? "25",
      ),
    },
    async (payload, context) => {
      const tenantId = tenantIdFromSubject(context.subject);
      await worker.process(parseAttributionSignalEvent(payload, tenantId));
    },
    {
      onError: (error, context) => {
        log.error(
          {
            err: error,
            subject: context.subject,
            sequence: context.streamSequence,
          },
          "attribution signal processing failed",
        );
      },
      onExhausted: async (payload, context, error) =>
        enqueueDeadLetter(outboxRepository, payload, context, error),
    },
  );
};

if (process.env.WORKER_BOOTSTRAP === "true") {
  initOtelSdk({ serviceName: "growthos.worker-attribution" });
  const { worker, outboxRepository } = createAttributionRuntimeFromEnv();
  await startAttributionSignalConsumer(worker, outboxRepository);
  log.info(
    {
      subject:
        process.env.ATTRIBUTION_SIGNAL_SUBJECT ?? "t.*.attribution.signal.v1",
    },
    "@growthos/worker-attribution initialized",
  );
}

export * from "./attribution-worker.js";
export * from "./contracts.js";
