import {
  JSONCodec,
  type JetStreamClient,
  type NatsConnection,
  connect,
} from "nats";
import { z } from "zod";
import type { EventPublisher } from "./learning-worker.js";

const natsConfigSchema = z.object({
  servers: z.string().min(1),
  name: z.string().default("growthos-worker-learning"),
});

export type NatsPublisherConfig = z.input<typeof natsConfigSchema>;

export const natsConfigFromEnv = (
  env: Record<string, string | undefined> = process.env,
): NatsPublisherConfig => ({
  servers: env.NATS_SERVERS ?? "nats://localhost:4222",
  name: env.NATS_CLIENT_NAME ?? "growthos-worker-learning",
});

export class NatsJetStreamPublisher implements EventPublisher {
  private readonly codec = JSONCodec<Record<string, unknown>>();

  constructor(
    private readonly connection: NatsConnection,
    private readonly jetstream: JetStreamClient = connection.jetstream(),
  ) {}

  static async connect(
    config: NatsPublisherConfig = natsConfigFromEnv(),
  ): Promise<NatsJetStreamPublisher> {
    const parsed = natsConfigSchema.parse(config);
    const connection = await connect({
      servers: parsed.servers,
      name: parsed.name,
    });

    return new NatsJetStreamPublisher(connection);
  }

  static async connectRaw(
    config: NatsPublisherConfig = natsConfigFromEnv(),
  ): Promise<NatsConnection> {
    const parsed = natsConfigSchema.parse(config);
    return connect({ servers: parsed.servers, name: parsed.name });
  }

  async publish(
    subject: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.jetstream.publish(subject, this.codec.encode(payload));
  }

  async close(): Promise<void> {
    await this.connection.drain();
  }
}
