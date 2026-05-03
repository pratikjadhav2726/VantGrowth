import { randomUUID } from "node:crypto";
import { RestateHttpWorkflowClient } from "@growthos/core";
import {
  PostgresOutboxRepository,
  createDb,
  tenantScopedSubject,
} from "@growthos/db";
import {
  NatsJetStreamPublisher,
  OutboxPublisher,
} from "@growthos/worker-outbox-publisher";
import { JSONCodec, connect } from "nats";
import { parseSmokeEnv } from "./smoke-env.js";

const main = async () => {
  const env = parseSmokeEnv(process.env);
  const db = createDb({ connectionString: env.DATABASE_URL, poolMax: 1 });

  const nats = await connect({
    servers: env.NATS_SERVERS,
    name: "growthos-infra-smoke",
  });

  try {
    const repository = new PostgresOutboxRepository(db, {
      actorKind: "system",
    });
    const smokeId = randomUUID();
    const eventType = "growthos.infra_smoke.v1";
    const outboxEvent = await repository.enqueue({
      tenantId: env.GROWTHOS_SMOKE_TENANT_ID,
      eventType,
      idempotencyKey: smokeId,
      payload: {
        smokeId,
        source: "infra-smoke",
        checkedAt: new Date().toISOString(),
      },
    });

    const subject = tenantScopedSubject(
      env.GROWTHOS_SMOKE_TENANT_ID,
      eventType,
    );

    const jetPublisher = new NatsJetStreamPublisher(nats);
    const outboxPublisher = new OutboxPublisher({
      outboxRepository: repository,
      eventPublisher: jetPublisher,
    });

    const publishedCount = await outboxPublisher.publishPendingForTenant(
      env.GROWTHOS_SMOKE_TENANT_ID,
      50,
    );

    if (publishedCount !== 1) {
      throw new Error(
        `Expected outbox publisher to drain exactly 1 event, got ${publishedCount}.`,
      );
    }

    const remaining = await repository.listUnconsumed(
      env.GROWTHOS_SMOKE_TENANT_ID,
      10,
    );
    if (remaining.length !== 0) {
      throw new Error(
        `Expected outbox row to be consumed after publish; still unconsumed: ${remaining.length}.`,
      );
    }

    const codec = JSONCodec<Record<string, unknown>>();
    const jsm = await nats.jetstreamManager();
    const stored = await jsm.streams.getMessage(env.GROWTHOS_JETSTREAM_STREAM, {
      last_by_subj: subject,
    });
    if (stored.subject !== subject) {
      throw new Error(
        `JetStream message subject mismatch: want ${subject}, got ${stored.subject}.`,
      );
    }
    const storedPayload = codec.decode(stored.data);
    if (
      storedPayload.smokeId !== smokeId ||
      storedPayload.source !== "infra-smoke"
    ) {
      throw new Error(
        "JetStream persistence check failed: stored payload does not match enqueued outbox payload.",
      );
    }

    const report: Record<string, unknown> = {
      ok: true,
      postgres: {
        outboxEventId: outboxEvent.id,
        tenantId: outboxEvent.tenantId,
        consumed: true,
        drainPublishedCount: publishedCount,
      },
      nats: {
        stream: env.GROWTHOS_JETSTREAM_STREAM,
        sequence: stored.seq,
        subject,
        persisted: true,
        outboxDrainPath: "@growthos/worker-outbox-publisher",
      },
    };

    if (env.RESTATE_BASE_URL && env.GROWTHOS_SMOKE_WORKFLOW_ID) {
      const restate = new RestateHttpWorkflowClient({
        baseUrl: env.RESTATE_BASE_URL,
        ...(env.RESTATE_API_KEY ? { apiKey: env.RESTATE_API_KEY } : {}),
        timeoutMs: env.RESTATE_TIMEOUT_MS ?? 5_000,
      });
      const runtimeState = await restate.getTenantProvisioningRuntimeState({
        tenantId: env.GROWTHOS_SMOKE_TENANT_ID,
        workflowId: env.GROWTHOS_SMOKE_WORKFLOW_ID,
      });
      report.restate = {
        workflowId: runtimeState.workflowId,
        tenantId: runtimeState.tenantId,
        state: runtimeState.state,
        runtimeRunId: runtimeState.runtimeRunId ?? null,
        historyLength: runtimeState.history.length,
        failureCode: runtimeState.failureCode ?? null,
        failureMessage: runtimeState.failureMessage ?? null,
      };
    }

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await nats.drain();
  }
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
