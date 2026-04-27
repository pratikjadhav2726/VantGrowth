import { describe, expect, it, vi } from "vitest";
import { NatsJetStreamPublisher } from "./nats-publisher.js";

describe("NatsJetStreamPublisher", () => {
  it("publishes encoded payloads through JetStream", async () => {
    const publish = vi.fn(async () => ({ seq: 1, stream: "GROWTHOS" }));
    const connection = {
      jetstream: () => ({ publish }),
      drain: vi.fn(async () => undefined),
    };

    const publisher = new NatsJetStreamPublisher(connection as never);
    await publisher.publish("t.tenant.signal.routed.v1", {
      signal_id: "sig-1",
    });

    expect(publish).toHaveBeenCalledTimes(1);
    const calls = publish.mock.calls as unknown as Array<[string, Uint8Array]>;
    expect(calls[0]?.[0]).toBe("t.tenant.signal.routed.v1");
    expect(calls[0]?.[1]).toBeInstanceOf(Uint8Array);
  });
});
