import { JSONCodec, type NatsConnection, connect } from "nats";
import type { EventPublisher } from "./blog-draft-worker.js";

export class NatsJetStreamPublisher implements EventPublisher {
  private readonly codec = JSONCodec<Record<string, unknown>>();

  constructor(private readonly connection: NatsConnection) {}

  static async connect(
    servers = process.env.NATS_SERVERS ?? "nats://localhost:4222",
    name = process.env.NATS_CLIENT_NAME ??
      "growthos-worker-blog-draft-publisher",
  ): Promise<NatsJetStreamPublisher> {
    const connection = await connect({ servers, name });
    return new NatsJetStreamPublisher(connection);
  }

  async publish(
    subject: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    this.connection.publish(subject, this.codec.encode(payload));
  }
}
