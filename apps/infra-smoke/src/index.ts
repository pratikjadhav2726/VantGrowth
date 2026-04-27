import { randomUUID } from "node:crypto";
import { PostgresOutboxRepository } from "@growthos/db";
import { JSONCodec, connect } from "nats";
import pg from "pg";
import { z } from "zod";

const { Pool } = pg;

const smokeEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  NATS_SERVERS: z.string().min(1).default("nats://localhost:4222"),
  GROWTHOS_SMOKE_TENANT_ID: z
    .string()
    .uuid()
    .default("00000000-0000-4000-8000-000000000001"),
});

const main = async () => {
  const env = smokeEnvSchema.parse(process.env);
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 1,
  });

  const nats = await connect({
    servers: env.NATS_SERVERS,
    name: "growthos-infra-smoke",
  });

  try {
    const repository = new PostgresOutboxRepository(pool, {
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

    console.log(
      JSON.stringify(
        {
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
        },
        null,
        2,
      ),
    );
  } finally {
    await nats.drain();
    await pool.end();
  }
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
