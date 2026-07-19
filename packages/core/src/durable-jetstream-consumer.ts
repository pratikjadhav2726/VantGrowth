import {
  JSONCodec,
  connect,
  consumerOpts,
  type JsMsg,
  type JetStreamSubscription,
  type NatsConnection,
} from "nats";
import { z } from "zod";

/**
 * Shared durable-consumer primitive for GrowthOS workers.
 *
 * GrowthOS writes domain events to Postgres first, then the outbox publisher
 * commits them to JetStream. Workers must consume those events durably: core
 * NATS subscriptions are not sufficient because a worker restart would lose
 * events published while it was offline.
 *
 * The consumer is deliberately at-least-once. Handlers therefore must make
 * their own writes idempotent (normally through the tenant-scoped outbox).
 */
export const durableJetStreamConsumerConfigSchema = z.object({
  servers: z.string().min(1).default("nats://localhost:4222"),
  streamName: z.string().min(1).default("GROWTHOS"),
  subject: z.string().min(1),
  durableName: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/, "durableName must be NATS-safe"),
  queueGroup: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_.-]+$/, "queueGroup must be NATS-safe"),
  ackWaitMs: z.number().int().positive().max(15 * 60_000).default(60_000),
  maxDeliver: z.number().int().min(1).max(100).default(5),
  retryDelayMs: z.number().int().positive().max(15 * 60_000).default(5_000),
  maxAckPending: z.number().int().positive().max(10_000).default(25),
  /**
   * Push-consumer delivery subject. Must remain stable across process
   * restarts; an ephemeral inbox would leave a durable consumer delivering to
   * a departed subscriber after its first restart.
   */
  deliverySubject: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9_.*>-]+(?:\.[A-Za-z0-9_.*>-]+)*$/, "invalid NATS subject")
    .optional(),
  clientName: z.string().min(1).max(255).optional(),
});

export type DurableJetStreamConsumerConfig = z.infer<
  typeof durableJetStreamConsumerConfigSchema
>;

export interface DurableMessageContext {
  subject: string;
  streamSequence: number;
  redeliveryCount: number;
}

export type DurableMessageHandler = (
  payload: Record<string, unknown>,
  context: DurableMessageContext,
) => Promise<void>;

export type DurableMessageFailureHandler = (
  payload: Record<string, unknown> | null,
  context: DurableMessageContext,
  error: Error,
) => Promise<void>;

export interface DurableJetStreamConsumerDependencies {
  connection?: NatsConnection;
  onError?: (error: Error, context: DurableMessageContext) => void;
  onExhausted?: DurableMessageFailureHandler;
}

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const toContext = (message: JsMsg): DurableMessageContext => ({
  subject: message.subject,
  streamSequence: message.seq,
  redeliveryCount: message.info.redeliveryCount,
});

/**
 * A stop handle intentionally owns the NATS connection only when this helper
 * created it. This lets callers share a test connection safely.
 */
export interface DurableConsumerHandle {
  close(): Promise<void>;
}

/**
 * Starts a JetStream push consumer with explicit acknowledgements and bounded
 * delivery attempts. A successfully handled message is acknowledged only
 * after the handler returns; failed messages are retried with a bounded delay.
 *
 * On the last allowed delivery we invoke `onExhausted` before terminating the
 * message. Callers should persist an incident/dead-letter event there; simply
 * logging an exhausted event would silently lose work.
 */
export const startDurableJetStreamConsumer = async (
  rawConfig: DurableJetStreamConsumerConfig,
  handler: DurableMessageHandler,
  deps: DurableJetStreamConsumerDependencies = {},
): Promise<DurableConsumerHandle> => {
  const config = durableJetStreamConsumerConfigSchema.parse(rawConfig);
  const ownsConnection = deps.connection === undefined;
  const connection =
    deps.connection ??
    (await connect({
      servers: config.servers,
      ...(config.clientName ? { name: config.clientName } : {}),
    }));
  const jetstream = connection.jetstream();
  const options = consumerOpts();

  options.durable(config.durableName);
  // The subscription itself is transient, but the push consumer is durable.
  // Using a stable delivery subject plus a queue group lets a restarted or
  // scaled worker resume the exact same durable cursor. `createInbox()` here
  // would make the server retain an unreachable delivery subject on restart.
  options.deliverTo(
    config.deliverySubject ?? `_INBOX.growthos.${config.durableName}`,
  );
  options.deliverAll();
  options.manualAck();
  options.ackExplicit();
  options.ackWait(config.ackWaitMs);
  options.maxDeliver(config.maxDeliver);
  options.maxAckPending(config.maxAckPending);
  options.filterSubject(config.subject);
  options.queue(config.queueGroup);
  options.bindStream(config.streamName);

  let subscription: JetStreamSubscription;
  try {
    subscription = await jetstream.subscribe(config.subject, options);
  } catch (error) {
    if (ownsConnection) await connection.drain().catch(() => undefined);
    throw error;
  }

  void (async () => {
    for await (const message of subscription) {
      const context = toContext(message);
      let payload: Record<string, unknown> | null = null;

      try {
        payload = JSONCodec<Record<string, unknown>>().decode(message.data);
        await handler(payload, context);
        message.ack();
      } catch (rawError) {
        const error = toError(rawError);
        deps.onError?.(error, context);

        if (context.redeliveryCount >= config.maxDeliver) {
          try {
            await deps.onExhausted?.(payload, context, error);
            message.term(
              `GrowthOS consumer exhausted after ${context.redeliveryCount} deliveries: ${error.message}`,
            );
          } catch (exhaustedError) {
            // Do not acknowledge a message whose incident/dead-letter record
            // could not be persisted. It remains eligible for recovery.
            message.nak(config.retryDelayMs);
            deps.onError?.(toError(exhaustedError), context);
          }
          continue;
        }

        message.nak(config.retryDelayMs);
      }
    }
  })().catch((error: unknown) => {
    // A connection-level failure is surfaced through the caller's logger. The
    // process supervisor restarts the worker; the durable cursor resumes it.
    deps.onError?.(toError(error), {
      subject: config.subject,
      streamSequence: 0,
      redeliveryCount: 0,
    });
  });

  return {
    async close(): Promise<void> {
      subscription.unsubscribe();
      if (ownsConnection) await connection.drain();
    },
  };
};
