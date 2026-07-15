import {
  type EnqueueOutboxEvent,
  type StoredOutboxEvent,
  enqueueOutboxEventSchema,
  storedOutboxEventSchema,
} from "./contracts.js";

export interface OutboxRepository {
  enqueue(command: EnqueueOutboxEvent): Promise<StoredOutboxEvent>;
  markConsumed(
    tenantId: string,
    eventId: string,
    consumedAt?: Date,
  ): Promise<StoredOutboxEvent>;
  listUnconsumed(tenantId: string, limit: number): Promise<StoredOutboxEvent[]>;
  listByEventType(
    tenantId: string,
    eventType: string,
    limit: number,
  ): Promise<StoredOutboxEvent[]>;
}

const outboxIdempotencyKey = (command: EnqueueOutboxEvent): string =>
  `${command.tenantId}:${command.eventType}:${command.idempotencyKey}`;

export class InMemoryOutboxRepository implements OutboxRepository {
  private readonly eventsById = new Map<string, StoredOutboxEvent>();
  private readonly idsByIdempotencyKey = new Map<string, string>();
  private sequence = 0;

  async enqueue(command: EnqueueOutboxEvent): Promise<StoredOutboxEvent> {
    const parsed = enqueueOutboxEventSchema.parse(command);
    const idempotencyKey = outboxIdempotencyKey(parsed);
    const existingId = this.idsByIdempotencyKey.get(idempotencyKey);

    if (existingId) {
      const existing = this.eventsById.get(existingId);
      if (!existing)
        throw new Error(
          `Outbox idempotency index is corrupt for ${existingId}`,
        );
      return existing;
    }

    const event = storedOutboxEventSchema.parse({
      ...parsed,
      id: String(++this.sequence),
      createdAt: new Date(),
      consumedAt: null,
    });

    this.eventsById.set(event.id, event);
    this.idsByIdempotencyKey.set(idempotencyKey, event.id);
    return event;
  }

  async markConsumed(
    tenantId: string,
    eventId: string,
    consumedAt = new Date(),
  ): Promise<StoredOutboxEvent> {
    const event = this.eventsById.get(eventId);
    if (!event) throw new Error(`Outbox event not found: ${eventId}`);
    if (event.tenantId !== tenantId)
      throw new Error(`Outbox event not found for tenant: ${eventId}`);

    const consumed = storedOutboxEventSchema.parse({
      ...event,
      consumedAt,
    });

    this.eventsById.set(eventId, consumed);
    return consumed;
  }

  async listUnconsumed(
    tenantId: string,
    limit: number,
  ): Promise<StoredOutboxEvent[]> {
    return Array.from(this.eventsById.values())
      .filter(
        (event) => event.tenantId === tenantId && event.consumedAt === null,
      )
      .sort((a, b) => Number(a.id) - Number(b.id))
      .slice(0, limit);
  }

  async listByEventType(
    tenantId: string,
    eventType: string,
    limit: number,
  ): Promise<StoredOutboxEvent[]> {
    return Array.from(this.eventsById.values())
      .filter(
        (event) => event.tenantId === tenantId && event.eventType === eventType,
      )
      .sort((a, b) => Number(b.id) - Number(a.id))
      .slice(0, limit);
  }
}
