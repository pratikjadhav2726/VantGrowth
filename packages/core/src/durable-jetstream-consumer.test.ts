import { describe, expect, it } from "vitest";
import { durableJetStreamConsumerConfigSchema } from "./durable-jetstream-consumer.js";

describe("durableJetStreamConsumerConfigSchema", () => {
  it("applies bounded, production-safe defaults", () => {
    const result = durableJetStreamConsumerConfigSchema.parse({
      subject: "t.*.signal.routed.v1",
      durableName: "growthos_signal_router",
      queueGroup: "growthos-signal-router",
    });

    expect(result).toMatchObject({
      servers: "nats://localhost:4222",
      streamName: "GROWTHOS",
      ackWaitMs: 60_000,
      maxDeliver: 5,
      retryDelayMs: 5_000,
      maxAckPending: 25,
    });
    expect(result.deliverySubject).toBeUndefined();
  });

  it("accepts only stable, NATS-safe delivery subjects", () => {
    expect(
      durableJetStreamConsumerConfigSchema.parse({
        subject: "t.*.signal.routed.v1",
        durableName: "growthos_signal_router",
        queueGroup: "growthos-signal-router",
        deliverySubject: "_INBOX.growthos.growthos_signal_router",
      }).deliverySubject,
    ).toBe("_INBOX.growthos.growthos_signal_router");

    expect(() =>
      durableJetStreamConsumerConfigSchema.parse({
        subject: "t.*.signal.routed.v1",
        durableName: "growthos_signal_router",
        queueGroup: "growthos-signal-router",
        deliverySubject: "invalid subject with spaces",
      }),
    ).toThrow();
  });

  it("rejects unsafe durable identifiers and unbounded delivery settings", () => {
    expect(() =>
      durableJetStreamConsumerConfigSchema.parse({
        subject: "t.*.signal.routed.v1",
        durableName: "unsafe durable name",
        queueGroup: "growthos-signal-router",
      }),
    ).toThrow();

    expect(() =>
      durableJetStreamConsumerConfigSchema.parse({
        subject: "t.*.signal.routed.v1",
        durableName: "growthos_signal_router",
        queueGroup: "growthos-signal-router",
        maxDeliver: 101,
      }),
    ).toThrow();
  });
});
