import { randomUUID } from "node:crypto";
import { RestateHttpWorkflowClient } from "@growthos/core";
import { PostgresOutboxRepository, createDb } from "@growthos/db";
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
    const outboxEvent = await repository.enqueue({
      tenantId: env.GROWTHOS_SMOKE_TENANT_ID,
      eventType: "growthos.infra_smoke.v1",
      idempotencyKey: smokeId,
      payload: {
        smokeId,
        source: "infra-smoke",
        checkedAt: new Date().toISOString(),
      },
    });

    const subject = `growthos.${env.GROWTHOS_SMOKE_TENANT_ID}.infra_smoke.v1`;
    const codec = JSONCodec<Record<string, unknown>>();
    const ack = await nats.jetstream().publish(
      subject,
      codec.encode({
        outboxEventId: outboxEvent.id,
        tenantId: outboxEvent.tenantId,
        smokeId,
      }),
    );

    const report: Record<string, unknown> = {
      ok: true,
      postgres: {
        outboxEventId: outboxEvent.id,
        tenantId: outboxEvent.tenantId,
      },
      nats: {
        stream: ack.stream,
        sequence: ack.seq,
        subject,
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
