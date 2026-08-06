/**
 * Durable external-action lifecycle.
 *
 * An external action is created atomically with its dispatch outbox row. The
 * outbox publisher claims a short lease before calling n8n, records a provider
 * receipt or retry/failure, and n8n later sends a signed terminal callback.
 * The current row is deliberately paired with an append-only event ledger so
 * retries remain explainable and idempotent.
 */

import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  type EnqueueOutboxEvent,
  type StoredOutboxEvent,
  storedOutboxEventSchema,
  tenantIdSchema,
} from "./contracts.js";
import type { GrowthOsDb } from "./db.js";
import {
  type ExternalAction,
  type ExternalActionEvent,
  eventOutbox,
  externalActionEvents,
  externalActionStateValues,
  externalActions,
  incidents,
} from "./schema.js";
import type { TenantContext } from "./tenant-context.js";

type TxClient = Parameters<Parameters<GrowthOsDb["transaction"]>[0]>[0];

const actionIdSchema = z.string().min(1).max(255);
const idempotencyKeySchema = z.string().min(1).max(255);
const actionTypeSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z][a-z0-9._-]*$/);

export const externalActionRequestSchema = z.object({
  tenantId: tenantIdSchema,
  actionId: actionIdSchema,
  actionType: actionTypeSchema,
  approvedBy: z.string().min(1).max(255),
  idempotencyKey: idempotencyKeySchema,
  requestPayload: z.record(z.unknown()),
});
export type ExternalActionRequest = z.infer<typeof externalActionRequestSchema>;

export const externalActionRecordSchema = z.object({
  id: z.string().uuid(),
  tenantId: tenantIdSchema,
  actionId: actionIdSchema,
  idempotencyKey: idempotencyKeySchema,
  requestDigest: z.string().length(64),
  actionType: actionTypeSchema,
  approvedBy: z.string().min(1).max(255),
  requestPayload: z.record(z.unknown()),
  state: z.enum(externalActionStateValues),
  dispatchAttempts: z.number().int().nonnegative(),
  dispatchLeaseOwner: z.string().nullable(),
  dispatchLeaseExpiresAt: z.date().nullable(),
  lastDispatchAt: z.date().nullable(),
  nextRetryAt: z.date().nullable(),
  lastErrorCode: z.string().nullable(),
  lastErrorMessage: z.string().nullable(),
  dispatchReceipt: z.record(z.unknown()),
  outcome: z.record(z.unknown()),
  workflowId: z.string().nullable(),
  executionId: z.string().nullable(),
  providerReference: z.string().nullable(),
  outcomeReceivedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type ExternalActionRecord = z.infer<typeof externalActionRecordSchema>;

export const externalActionEventRecordSchema = z.object({
  id: z.string().uuid(),
  tenantId: tenantIdSchema,
  externalActionId: z.string().uuid(),
  eventKey: z.string().min(1),
  eventType: z.string().min(1),
  payload: z.record(z.unknown()),
  createdAt: z.date(),
});
export type ExternalActionEventRecord = z.infer<
  typeof externalActionEventRecordSchema
>;

export const externalActionOutcomeStatusSchema = z.enum([
  "completed",
  "failed",
]);
export type ExternalActionOutcomeStatus = z.infer<
  typeof externalActionOutcomeStatusSchema
>;

export const recordExternalActionOutcomeSchema = z.object({
  tenantId: tenantIdSchema,
  actionId: actionIdSchema,
  idempotencyKey: idempotencyKeySchema,
  callbackId: z.string().min(1).max(255),
  status: externalActionOutcomeStatusSchema,
  workflowId: z.string().min(1).max(255).optional(),
  executionId: z.string().min(1).max(255).optional(),
  providerReference: z.string().min(1).max(255).optional(),
  outcome: z.record(z.unknown()).default({}),
  errorCode: z.string().min(1).max(255).optional(),
  errorMessage: z.string().min(1).max(2_000).optional(),
  occurredAt: z.coerce.date().optional(),
});
export type RecordExternalActionOutcome = z.input<
  typeof recordExternalActionOutcomeSchema
>;

export interface DispatchReceipt {
  readonly httpStatus: number;
  readonly body: unknown;
  readonly workflowId?: string;
  readonly executionId?: string;
  readonly providerReference?: string;
}

export interface ClaimExternalActionDispatch {
  tenantId: string;
  actionId: string;
  idempotencyKey: string;
  leaseOwner: string;
  leaseDurationMs: number;
  now?: Date;
}

export type ExternalActionDispatchClaim =
  | { disposition: "claimed"; action: ExternalActionRecord }
  | { disposition: "deferred"; action: ExternalActionRecord }
  | { disposition: "in_flight"; action: ExternalActionRecord }
  | { disposition: "settled"; action: ExternalActionRecord };

export interface RecordDispatchAcceptedInput {
  tenantId: string;
  actionId: string;
  idempotencyKey: string;
  leaseOwner: string;
  receipt: DispatchReceipt;
  now?: Date;
}

export interface ScheduleDispatchRetryInput {
  tenantId: string;
  actionId: string;
  idempotencyKey: string;
  leaseOwner: string;
  retryAfterMs: number;
  errorCode?: string;
  errorMessage: string;
  now?: Date;
}

export interface FailExternalActionDispatchInput {
  tenantId: string;
  actionId: string;
  idempotencyKey: string;
  leaseOwner: string;
  errorCode?: string;
  errorMessage: string;
  now?: Date;
}

export interface EnqueueExternalActionResult {
  action: ExternalActionRecord;
  event: StoredOutboxEvent;
  isDuplicate: boolean;
}

export interface RecordExternalActionOutcomeResult {
  action: ExternalActionRecord;
  isDuplicate: boolean;
}

export interface ExternalActionsRepository {
  /** Atomically creates a requested action, audit event, and n8n outbox row. */
  enqueueRequested(
    request: ExternalActionRequest,
  ): Promise<EnqueueExternalActionResult>;
  /** Claims the action's dispatch lease or reports why it must not be sent yet. */
  claimDispatch(
    input: ClaimExternalActionDispatch,
  ): Promise<ExternalActionDispatchClaim>;
  recordDispatchAccepted(
    input: RecordDispatchAcceptedInput,
  ): Promise<ExternalActionRecord>;
  scheduleDispatchRetry(
    input: ScheduleDispatchRetryInput,
  ): Promise<ExternalActionRecord>;
  failDispatch(
    input: FailExternalActionDispatchInput,
  ): Promise<ExternalActionRecord>;
  /** Applies an HMAC-authenticated n8n terminal callback exactly once. */
  recordOutcome(
    input: RecordExternalActionOutcome,
  ): Promise<RecordExternalActionOutcomeResult>;
  getByActionId(
    tenantId: string,
    actionId: string,
  ): Promise<ExternalActionRecord | null>;
  listEvents(
    tenantId: string,
    actionId: string,
  ): Promise<ExternalActionEventRecord[]>;
}

export class ExternalActionNotFoundError extends Error {
  constructor(actionId: string) {
    super(`External action not found: ${actionId}`);
    this.name = "ExternalActionNotFoundError";
  }
}

export class ExternalActionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExternalActionConflictError";
  }
}

export class ExternalActionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExternalActionStateError";
  }
}

const externalActionOutboxEventType = "n8n.dispatch.requested.v1";
const terminalStates = new Set(["dispatched", "completed", "failed"]);
const callbackEligibleStates = [
  "requested",
  "dispatching",
  "retry_scheduled",
  "dispatched",
] as const;

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;

  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
};

export const externalActionRequestDigest = (
  request: ExternalActionRequest,
): string =>
  createHash("sha256")
    .update(
      stableJson({
        actionId: request.actionId,
        actionType: request.actionType,
        approvedBy: request.approvedBy,
        idempotencyKey: request.idempotencyKey,
        payload: request.requestPayload,
      }),
    )
    .digest("hex");

const sanitizeErrorMessage = (value: string): string =>
  value
    .replace(/(bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(api[_-]?key|token|secret)=[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 2_000);

const mapAction = (row: ExternalAction): ExternalActionRecord =>
  externalActionRecordSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    actionId: row.actionId,
    idempotencyKey: row.idempotencyKey,
    requestDigest: row.requestDigest,
    actionType: row.actionType,
    approvedBy: row.approvedBy,
    requestPayload: row.requestPayload,
    state: row.state,
    dispatchAttempts: row.dispatchAttempts,
    dispatchLeaseOwner: row.dispatchLeaseOwner ?? null,
    dispatchLeaseExpiresAt: row.dispatchLeaseExpiresAt ?? null,
    lastDispatchAt: row.lastDispatchAt ?? null,
    nextRetryAt: row.nextRetryAt ?? null,
    lastErrorCode: row.lastErrorCode ?? null,
    lastErrorMessage: row.lastErrorMessage ?? null,
    dispatchReceipt: row.dispatchReceipt,
    outcome: row.outcome,
    workflowId: row.workflowId ?? null,
    executionId: row.executionId ?? null,
    providerReference: row.providerReference ?? null,
    outcomeReceivedAt: row.outcomeReceivedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

const mapActionEvent = (row: ExternalActionEvent): ExternalActionEventRecord =>
  externalActionEventRecordSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    externalActionId: row.externalActionId,
    eventKey: row.eventKey,
    eventType: row.eventType,
    payload: row.payload,
    createdAt: row.createdAt,
  });

const mapOutbox = (row: typeof eventOutbox.$inferSelect): StoredOutboxEvent =>
  storedOutboxEventSchema.parse({
    id: String(row.id),
    tenantId: row.tenantId,
    eventType: row.eventType,
    idempotencyKey: row.idempotencyKey,
    payload: row.payload,
    createdAt: row.createdAt,
    consumedAt: row.consumedAt ?? null,
  });

const setTenantContext = (
  tx: TxClient,
  tenantId: string,
  context: Omit<TenantContext, "tenantId">,
) =>
  tx.execute(
    sql`SELECT
      set_config('app.tenant_id', ${tenantId}, true),
      set_config('app.actor_id', ${context.actorId ?? ""}, true),
      set_config('app.actor_kind', ${context.actorKind ?? "system"}, true)`,
  );

const lifecyclePayload = (
  action: ExternalActionRecord,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  external_action_id: action.id,
  action_id: action.actionId,
  action_type: action.actionType,
  state: action.state,
  dispatch_attempts: action.dispatchAttempts,
  ...(action.workflowId ? { workflow_id: action.workflowId } : {}),
  ...(action.executionId ? { execution_id: action.executionId } : {}),
  ...(action.providerReference
    ? { provider_reference: action.providerReference }
    : {}),
  ...extra,
});

const failureIncidentPayload = (
  action: ExternalActionRecord,
  phase: "dispatch" | "outcome",
): Record<string, unknown> => ({
  incident_key: `external-action:${action.id}:failed`,
  component_id: "n8n-dispatch",
  severity: "high",
  title: `External action ${action.actionId} failed`,
  summary: `n8n ${phase} failed for ${action.actionType}; founder review is required before retrying or replacing the action.`,
  diagnostic_metadata: {
    external_action_id: action.id,
    action_id: action.actionId,
    action_type: action.actionType,
    phase,
    dispatch_attempts: action.dispatchAttempts,
    error_code: action.lastErrorCode,
  },
});

const isSettled = (state: ExternalActionRecord["state"]): boolean =>
  terminalStates.has(state);

const validateDispatchIdentity = (input: {
  tenantId: string;
  actionId: string;
  idempotencyKey: string;
}): void => {
  tenantIdSchema.parse(input.tenantId);
  actionIdSchema.parse(input.actionId);
  idempotencyKeySchema.parse(input.idempotencyKey);
};

const transitionEventPayload = (
  action: ExternalActionRecord,
  eventType: string,
  details: Record<string, unknown> = {},
): Record<string, unknown> => ({
  state: action.state,
  action_id: action.actionId,
  action_type: action.actionType,
  dispatch_attempts: action.dispatchAttempts,
  event_type: eventType,
  ...details,
});

interface MutableActionStore {
  readonly now: () => Date;
}

// ─── In-memory implementation ─────────────────────────────────────────────

/**
 * In-memory implementation for route and worker tests. It intentionally uses
 * the same state-transition rules as Postgres while delegating durable-event
 * assertions to the supplied in-memory outbox repository.
 */
export class InMemoryExternalActionsRepository
  implements ExternalActionsRepository, MutableActionStore
{
  private readonly actionsById = new Map<string, ExternalActionRecord>();
  private readonly actionIndex = new Map<string, string>();
  private readonly idempotencyIndex = new Map<string, string>();
  private readonly eventsByActionId = new Map<
    string,
    ExternalActionEventRecord[]
  >();
  private sequence = 0;

  constructor(
    private readonly outboxRepository: {
      enqueue(command: EnqueueOutboxEvent): Promise<StoredOutboxEvent>;
    },
    readonly now: () => Date = () => new Date(),
  ) {}

  private key(tenantId: string, value: string): string {
    return `${tenantId}:${value}`;
  }

  private newId(): string {
    this.sequence += 1;
    return `00000000-0000-4000-8000-${String(this.sequence).padStart(12, "0")}`;
  }

  private save(action: ExternalActionRecord): ExternalActionRecord {
    this.actionsById.set(action.id, action);
    return action;
  }

  private find(
    tenantId: string,
    actionId: string,
    idempotencyKey?: string,
  ): ExternalActionRecord {
    const id = this.actionIndex.get(this.key(tenantId, actionId));
    const action = id ? this.actionsById.get(id) : undefined;
    if (
      !action ||
      (idempotencyKey && action.idempotencyKey !== idempotencyKey)
    ) {
      throw new ExternalActionNotFoundError(actionId);
    }
    return action;
  }

  private appendEvent(
    action: ExternalActionRecord,
    eventKey: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): void {
    const events = this.eventsByActionId.get(action.id) ?? [];
    if (events.some((event) => event.eventKey === eventKey)) return;
    events.push(
      externalActionEventRecordSchema.parse({
        id: this.newId(),
        tenantId: action.tenantId,
        externalActionId: action.id,
        eventKey,
        eventType,
        payload,
        createdAt: this.now(),
      }),
    );
    this.eventsByActionId.set(action.id, events);
  }

  private async emitLifecycle(
    action: ExternalActionRecord,
    eventType: string,
    idempotencyKey: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await this.outboxRepository.enqueue({
      tenantId: action.tenantId,
      eventType,
      idempotencyKey,
      payload: lifecyclePayload(action, extra),
    });
  }

  private async emitFailureIncident(
    action: ExternalActionRecord,
    phase: "dispatch" | "outcome",
  ): Promise<void> {
    await this.outboxRepository.enqueue({
      tenantId: action.tenantId,
      eventType: "incident.opened.v1",
      idempotencyKey: `external-action-failure:${action.id}`,
      payload: failureIncidentPayload(action, phase),
    });
  }

  async enqueueRequested(
    requestInput: ExternalActionRequest,
  ): Promise<EnqueueExternalActionResult> {
    const request = externalActionRequestSchema.parse(requestInput);
    const digest = externalActionRequestDigest(request);
    const byAction = this.actionIndex.get(
      this.key(request.tenantId, request.actionId),
    );
    const byIdempotency = this.idempotencyIndex.get(
      this.key(request.tenantId, request.idempotencyKey),
    );
    const existingId = byAction ?? byIdempotency;

    if (existingId) {
      const existing = this.actionsById.get(existingId);
      if (!existing)
        throw new Error("External action idempotency index is corrupt");
      if (
        existing.actionId !== request.actionId ||
        existing.idempotencyKey !== request.idempotencyKey ||
        existing.requestDigest !== digest
      ) {
        throw new ExternalActionConflictError(
          "actionId or idempotencyKey was reused with a different external action request",
        );
      }
      const event = await this.outboxRepository.enqueue({
        tenantId: request.tenantId,
        eventType: externalActionOutboxEventType,
        idempotencyKey: request.idempotencyKey,
        payload: {
          tenantId: request.tenantId,
          actionId: request.actionId,
          actionType: request.actionType,
          approvedBy: request.approvedBy,
          idempotencyKey: request.idempotencyKey,
          payload: request.requestPayload,
        },
      });
      return { action: existing, event, isDuplicate: true };
    }

    const now = this.now();
    const action = externalActionRecordSchema.parse({
      id: this.newId(),
      tenantId: request.tenantId,
      actionId: request.actionId,
      idempotencyKey: request.idempotencyKey,
      requestDigest: digest,
      actionType: request.actionType,
      approvedBy: request.approvedBy,
      requestPayload: request.requestPayload,
      state: "requested",
      dispatchAttempts: 0,
      dispatchLeaseOwner: null,
      dispatchLeaseExpiresAt: null,
      lastDispatchAt: null,
      nextRetryAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      dispatchReceipt: {},
      outcome: {},
      workflowId: null,
      executionId: null,
      providerReference: null,
      outcomeReceivedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    this.save(action);
    this.actionIndex.set(
      this.key(request.tenantId, request.actionId),
      action.id,
    );
    this.idempotencyIndex.set(
      this.key(request.tenantId, request.idempotencyKey),
      action.id,
    );
    this.appendEvent(
      action,
      `requested:${request.idempotencyKey}`,
      "requested",
      transitionEventPayload(action, "requested"),
    );
    const event = await this.outboxRepository.enqueue({
      tenantId: request.tenantId,
      eventType: externalActionOutboxEventType,
      idempotencyKey: request.idempotencyKey,
      payload: {
        tenantId: request.tenantId,
        actionId: request.actionId,
        actionType: request.actionType,
        approvedBy: request.approvedBy,
        idempotencyKey: request.idempotencyKey,
        payload: request.requestPayload,
      },
    });
    return { action, event, isDuplicate: false };
  }

  async claimDispatch(
    input: ClaimExternalActionDispatch,
  ): Promise<ExternalActionDispatchClaim> {
    validateDispatchIdentity(input);
    if (!input.leaseOwner || input.leaseDurationMs <= 0) {
      throw new ExternalActionStateError(
        "A positive dispatch lease is required",
      );
    }
    const action = this.find(
      input.tenantId,
      input.actionId,
      input.idempotencyKey,
    );
    const now = input.now ?? this.now();

    if (isSettled(action.state)) return { disposition: "settled", action };
    if (
      action.state === "retry_scheduled" &&
      action.nextRetryAt &&
      action.nextRetryAt.getTime() > now.getTime()
    ) {
      return { disposition: "deferred", action };
    }
    if (
      action.state === "dispatching" &&
      action.dispatchLeaseExpiresAt &&
      action.dispatchLeaseExpiresAt.getTime() > now.getTime()
    ) {
      return { disposition: "in_flight", action };
    }

    const claimed = this.save({
      ...action,
      state: "dispatching",
      dispatchAttempts: action.dispatchAttempts + 1,
      dispatchLeaseOwner: input.leaseOwner,
      dispatchLeaseExpiresAt: new Date(now.getTime() + input.leaseDurationMs),
      lastDispatchAt: now,
      nextRetryAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      updatedAt: now,
    });
    this.appendEvent(
      claimed,
      `dispatch_started:${claimed.dispatchAttempts}`,
      "dispatch_started",
      transitionEventPayload(claimed, "dispatch_started"),
    );
    return { disposition: "claimed", action: claimed };
  }

  async recordDispatchAccepted(
    input: RecordDispatchAcceptedInput,
  ): Promise<ExternalActionRecord> {
    validateDispatchIdentity(input);
    const action = this.find(
      input.tenantId,
      input.actionId,
      input.idempotencyKey,
    );
    if (isSettled(action.state)) return action;
    if (
      action.state !== "dispatching" ||
      action.dispatchLeaseOwner !== input.leaseOwner
    ) {
      throw new ExternalActionStateError(
        `Cannot record dispatch receipt while external action is ${action.state}`,
      );
    }
    const now = input.now ?? this.now();
    const accepted = this.save({
      ...action,
      state: "dispatched",
      dispatchLeaseOwner: null,
      dispatchLeaseExpiresAt: null,
      nextRetryAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      dispatchReceipt: {
        http_status: input.receipt.httpStatus,
        body: input.receipt.body,
      },
      workflowId: input.receipt.workflowId ?? action.workflowId,
      executionId: input.receipt.executionId ?? action.executionId,
      providerReference:
        input.receipt.providerReference ?? action.providerReference,
      updatedAt: now,
    });
    this.appendEvent(
      accepted,
      `dispatch_accepted:${accepted.dispatchAttempts}`,
      "dispatch_accepted",
      transitionEventPayload(accepted, "dispatch_accepted", {
        http_status: input.receipt.httpStatus,
      }),
    );
    await this.emitLifecycle(
      accepted,
      "external_action.dispatched.v1",
      `external-action:${accepted.id}:dispatched:${accepted.dispatchAttempts}`,
      { dispatch_receipt: accepted.dispatchReceipt },
    );
    return accepted;
  }

  async scheduleDispatchRetry(
    input: ScheduleDispatchRetryInput,
  ): Promise<ExternalActionRecord> {
    validateDispatchIdentity(input);
    if (input.retryAfterMs <= 0) {
      throw new ExternalActionStateError("retryAfterMs must be positive");
    }
    const action = this.find(
      input.tenantId,
      input.actionId,
      input.idempotencyKey,
    );
    if (isSettled(action.state)) return action;
    if (
      action.state !== "dispatching" ||
      action.dispatchLeaseOwner !== input.leaseOwner
    ) {
      throw new ExternalActionStateError(
        `Cannot schedule retry while external action is ${action.state}`,
      );
    }
    const now = input.now ?? this.now();
    const retry = this.save({
      ...action,
      state: "retry_scheduled",
      dispatchLeaseOwner: null,
      dispatchLeaseExpiresAt: null,
      nextRetryAt: new Date(now.getTime() + input.retryAfterMs),
      lastErrorCode: input.errorCode ?? "N8N_RETRYABLE_DISPATCH_FAILURE",
      lastErrorMessage: sanitizeErrorMessage(input.errorMessage),
      updatedAt: now,
    });
    this.appendEvent(
      retry,
      `dispatch_retry_scheduled:${retry.dispatchAttempts}`,
      "dispatch_retry_scheduled",
      transitionEventPayload(retry, "dispatch_retry_scheduled", {
        retry_after: retry.nextRetryAt?.toISOString(),
        error_code: retry.lastErrorCode,
      }),
    );
    await this.emitLifecycle(
      retry,
      "external_action.retry_scheduled.v1",
      `external-action:${retry.id}:retry:${retry.dispatchAttempts}`,
      {
        retry_at: retry.nextRetryAt?.toISOString(),
        error_code: retry.lastErrorCode,
      },
    );
    return retry;
  }

  async failDispatch(
    input: FailExternalActionDispatchInput,
  ): Promise<ExternalActionRecord> {
    validateDispatchIdentity(input);
    const action = this.find(
      input.tenantId,
      input.actionId,
      input.idempotencyKey,
    );
    if (isSettled(action.state)) return action;
    if (
      action.state !== "dispatching" ||
      action.dispatchLeaseOwner !== input.leaseOwner
    ) {
      throw new ExternalActionStateError(
        `Cannot fail dispatch while external action is ${action.state}`,
      );
    }
    const now = input.now ?? this.now();
    const failed = this.save({
      ...action,
      state: "failed",
      dispatchLeaseOwner: null,
      dispatchLeaseExpiresAt: null,
      nextRetryAt: null,
      lastErrorCode: input.errorCode ?? "N8N_PERMANENT_DISPATCH_FAILURE",
      lastErrorMessage: sanitizeErrorMessage(input.errorMessage),
      updatedAt: now,
    });
    this.appendEvent(
      failed,
      `dispatch_failed:${failed.dispatchAttempts}`,
      "dispatch_failed",
      transitionEventPayload(failed, "dispatch_failed", {
        error_code: failed.lastErrorCode,
      }),
    );
    await this.emitLifecycle(
      failed,
      "external_action.failed.v1",
      `external-action:${failed.id}:failed`,
      { phase: "dispatch", error_code: failed.lastErrorCode },
    );
    await this.emitFailureIncident(failed, "dispatch");
    return failed;
  }

  async recordOutcome(
    inputValue: RecordExternalActionOutcome,
  ): Promise<RecordExternalActionOutcomeResult> {
    const input = recordExternalActionOutcomeSchema.parse(inputValue);
    const action = this.find(
      input.tenantId,
      input.actionId,
      input.idempotencyKey,
    );
    const eventKey = `callback:${input.callbackId}`;
    const events = this.eventsByActionId.get(action.id) ?? [];
    if (events.some((event) => event.eventKey === eventKey)) {
      return { action, isDuplicate: true };
    }
    if (action.state === "completed" || action.state === "failed") {
      throw new ExternalActionStateError(
        `Cannot apply a new callback to terminal external action ${action.actionId}`,
      );
    }

    const now = input.occurredAt ?? this.now();
    const completed = input.status === "completed";
    const transitioned = this.save({
      ...action,
      state: input.status,
      dispatchLeaseOwner: null,
      dispatchLeaseExpiresAt: null,
      nextRetryAt: null,
      workflowId: input.workflowId ?? action.workflowId,
      executionId: input.executionId ?? action.executionId,
      providerReference: input.providerReference ?? action.providerReference,
      outcome: input.outcome,
      outcomeReceivedAt: now,
      lastErrorCode: completed
        ? null
        : (input.errorCode ?? "N8N_EXECUTION_FAILED"),
      lastErrorMessage: completed
        ? null
        : sanitizeErrorMessage(
            input.errorMessage ?? "n8n reported a failed action outcome",
          ),
      updatedAt: now,
    });
    this.appendEvent(
      transitioned,
      eventKey,
      completed ? "outcome_completed" : "outcome_failed",
      transitionEventPayload(
        transitioned,
        completed ? "outcome_completed" : "outcome_failed",
        {
          callback_id: input.callbackId,
          error_code: transitioned.lastErrorCode,
        },
      ),
    );
    await this.emitLifecycle(
      transitioned,
      completed ? "external_action.completed.v1" : "external_action.failed.v1",
      `external-action:${transitioned.id}:${completed ? "completed" : "failed"}:${input.callbackId}`,
      {
        phase: "outcome",
        callback_id: input.callbackId,
        outcome: transitioned.outcome,
        ...(transitioned.lastErrorCode
          ? { error_code: transitioned.lastErrorCode }
          : {}),
      },
    );
    if (!completed) await this.emitFailureIncident(transitioned, "outcome");
    return { action: transitioned, isDuplicate: false };
  }

  async getByActionId(
    tenantId: string,
    actionId: string,
  ): Promise<ExternalActionRecord | null> {
    tenantIdSchema.parse(tenantId);
    actionIdSchema.parse(actionId);
    const id = this.actionIndex.get(this.key(tenantId, actionId));
    return id ? (this.actionsById.get(id) ?? null) : null;
  }

  async listEvents(
    tenantId: string,
    actionId: string,
  ): Promise<ExternalActionEventRecord[]> {
    const action = this.find(tenantId, actionId);
    return [...(this.eventsByActionId.get(action.id) ?? [])];
  }
}

// ─── Postgres implementation ──────────────────────────────────────────────

const loadAction = async (
  tx: TxClient,
  tenantId: string,
  actionId: string,
): Promise<ExternalActionRecord | null> => {
  const [row] = await tx
    .select()
    .from(externalActions)
    .where(
      and(
        eq(externalActions.tenantId, tenantId),
        eq(externalActions.actionId, actionId),
      ),
    )
    .limit(1);
  return row ? mapAction(row) : null;
};

const loadActionByIdempotency = async (
  tx: TxClient,
  tenantId: string,
  idempotencyKey: string,
): Promise<ExternalActionRecord | null> => {
  const [row] = await tx
    .select()
    .from(externalActions)
    .where(
      and(
        eq(externalActions.tenantId, tenantId),
        eq(externalActions.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return row ? mapAction(row) : null;
};

const requireAction = async (
  tx: TxClient,
  tenantId: string,
  actionId: string,
  idempotencyKey?: string,
): Promise<ExternalActionRecord> => {
  const action = await loadAction(tx, tenantId, actionId);
  if (!action || (idempotencyKey && action.idempotencyKey !== idempotencyKey)) {
    throw new ExternalActionNotFoundError(actionId);
  }
  return action;
};

const appendActionEvent = async (
  tx: TxClient,
  action: ExternalActionRecord,
  eventKey: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<boolean> => {
  const rows = await tx
    .insert(externalActionEvents)
    .values({
      tenantId: action.tenantId,
      externalActionId: action.id,
      eventKey,
      eventType,
      payload,
    })
    .onConflictDoNothing({
      target: [
        externalActionEvents.tenantId,
        externalActionEvents.externalActionId,
        externalActionEvents.eventKey,
      ],
    })
    .returning({ id: externalActionEvents.id });
  return rows.length > 0;
};

const enqueueOutbox = async (
  tx: TxClient,
  command: EnqueueOutboxEvent,
): Promise<StoredOutboxEvent> => {
  await tx
    .insert(eventOutbox)
    .values({
      tenantId: command.tenantId,
      eventType: command.eventType,
      idempotencyKey: command.idempotencyKey,
      payload: command.payload,
    })
    .onConflictDoNothing({
      target: [
        eventOutbox.tenantId,
        eventOutbox.eventType,
        eventOutbox.idempotencyKey,
      ],
    });

  const [row] = await tx
    .select()
    .from(eventOutbox)
    .where(
      and(
        eq(eventOutbox.tenantId, command.tenantId),
        eq(eventOutbox.eventType, command.eventType),
        eq(eventOutbox.idempotencyKey, command.idempotencyKey),
      ),
    )
    .limit(1);
  if (!row)
    throw new Error("Failed to enqueue or load external action outbox event");

  await tx.execute(
    sql`SELECT pg_notify(
      'growthos_outbox_events',
      ${JSON.stringify({ tenantId: command.tenantId, eventId: String(row.id) })}
    )`,
  );
  return mapOutbox(row);
};

const emitLifecycleOutbox = async (
  tx: TxClient,
  action: ExternalActionRecord,
  eventType: string,
  idempotencyKey: string,
  extra: Record<string, unknown> = {},
): Promise<void> => {
  await enqueueOutbox(tx, {
    tenantId: action.tenantId,
    eventType,
    idempotencyKey,
    payload: lifecyclePayload(action, extra),
  });
};

const emitFailureIncidentOutbox = async (
  tx: TxClient,
  action: ExternalActionRecord,
  phase: "dispatch" | "outcome",
): Promise<void> => {
  const incidentPayload = failureIncidentPayload(action, phase);
  const now = new Date();
  // The control-plane reads `incidents` directly, so an outbox notification
  // alone is not enough. Upsert the durable incident in the same transaction
  // as the failed action transition; the outbox event then fans it out to
  // operational consumers without creating a consistency window.
  await tx
    .insert(incidents)
    .values({
      tenantId: action.tenantId,
      incidentKey: String(incidentPayload.incident_key),
      componentId: "n8n-dispatch",
      severity: "high",
      status: "open",
      title: String(incidentPayload.title),
      summary: String(incidentPayload.summary),
      action: "quarantine_and_escalate",
      diagnosticMetadata:
        (incidentPayload.diagnostic_metadata as Record<string, unknown>) ?? {},
      openedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [incidents.tenantId, incidents.incidentKey],
      set: {
        severity: "high",
        status: "open",
        title: String(incidentPayload.title),
        summary: String(incidentPayload.summary),
        action: "quarantine_and_escalate",
        diagnosticMetadata:
          (incidentPayload.diagnostic_metadata as Record<string, unknown>) ??
          {},
        updatedAt: now,
      },
    });
  await enqueueOutbox(tx, {
    tenantId: action.tenantId,
    eventType: "incident.opened.v1",
    idempotencyKey: `external-action-failure:${action.id}`,
    payload: incidentPayload,
  });
};

export class PostgresExternalActionsRepository
  implements ExternalActionsRepository
{
  constructor(
    private readonly db: GrowthOsDb,
    private readonly context: Omit<TenantContext, "tenantId"> = {
      actorKind: "system",
    },
  ) {}

  async enqueueRequested(
    requestInput: ExternalActionRequest,
  ): Promise<EnqueueExternalActionResult> {
    const request = externalActionRequestSchema.parse(requestInput);
    const digest = externalActionRequestDigest(request);

    return this.db.transaction(async (tx) => {
      await setTenantContext(tx, request.tenantId, this.context);
      const inserted = await tx
        .insert(externalActions)
        .values({
          tenantId: request.tenantId,
          actionId: request.actionId,
          idempotencyKey: request.idempotencyKey,
          requestDigest: digest,
          actionType: request.actionType,
          approvedBy: request.approvedBy,
          requestPayload: request.requestPayload,
        })
        .onConflictDoNothing()
        .returning();

      const byAction = await loadAction(tx, request.tenantId, request.actionId);
      const byIdempotency = await loadActionByIdempotency(
        tx,
        request.tenantId,
        request.idempotencyKey,
      );
      const action = byAction ?? byIdempotency;
      if (!action) throw new Error("Failed to create or load external action");
      if (
        action.actionId !== request.actionId ||
        action.idempotencyKey !== request.idempotencyKey ||
        action.requestDigest !== digest
      ) {
        throw new ExternalActionConflictError(
          "actionId or idempotencyKey was reused with a different external action request",
        );
      }

      if (inserted.length > 0) {
        await appendActionEvent(
          tx,
          action,
          `requested:${request.idempotencyKey}`,
          "requested",
          transitionEventPayload(action, "requested"),
        );
      }
      const event = await enqueueOutbox(tx, {
        tenantId: request.tenantId,
        eventType: externalActionOutboxEventType,
        idempotencyKey: request.idempotencyKey,
        payload: {
          tenantId: request.tenantId,
          actionId: request.actionId,
          actionType: request.actionType,
          approvedBy: request.approvedBy,
          idempotencyKey: request.idempotencyKey,
          payload: request.requestPayload,
        },
      });
      return { action, event, isDuplicate: inserted.length === 0 };
    });
  }

  async claimDispatch(
    input: ClaimExternalActionDispatch,
  ): Promise<ExternalActionDispatchClaim> {
    validateDispatchIdentity(input);
    if (!input.leaseOwner || input.leaseDurationMs <= 0) {
      throw new ExternalActionStateError(
        "A positive dispatch lease is required",
      );
    }
    const now = input.now ?? new Date();
    const leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs);

    return this.db.transaction(async (tx) => {
      await setTenantContext(tx, input.tenantId, this.context);
      const current = await requireAction(
        tx,
        input.tenantId,
        input.actionId,
        input.idempotencyKey,
      );
      if (isSettled(current.state))
        return { disposition: "settled", action: current };
      if (
        current.state === "retry_scheduled" &&
        current.nextRetryAt &&
        current.nextRetryAt.getTime() > now.getTime()
      ) {
        return { disposition: "deferred", action: current };
      }
      if (
        current.state === "dispatching" &&
        current.dispatchLeaseExpiresAt &&
        current.dispatchLeaseExpiresAt.getTime() > now.getTime()
      ) {
        return { disposition: "in_flight", action: current };
      }

      const [claimedRow] = await tx
        .update(externalActions)
        .set({
          state: "dispatching",
          dispatchAttempts: sql`${externalActions.dispatchAttempts} + 1`,
          dispatchLeaseOwner: input.leaseOwner,
          dispatchLeaseExpiresAt: leaseExpiresAt,
          lastDispatchAt: now,
          nextRetryAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(externalActions.tenantId, input.tenantId),
            eq(externalActions.actionId, input.actionId),
            eq(externalActions.idempotencyKey, input.idempotencyKey),
            or(
              and(
                inArray(externalActions.state, [
                  "requested",
                  "retry_scheduled",
                ]),
                or(
                  isNull(externalActions.nextRetryAt),
                  lte(externalActions.nextRetryAt, now),
                ),
              ),
              and(
                eq(externalActions.state, "dispatching"),
                or(
                  isNull(externalActions.dispatchLeaseExpiresAt),
                  lte(externalActions.dispatchLeaseExpiresAt, now),
                ),
              ),
            ),
          ),
        )
        .returning();
      if (!claimedRow) {
        const refreshed = await requireAction(
          tx,
          input.tenantId,
          input.actionId,
          input.idempotencyKey,
        );
        if (isSettled(refreshed.state)) {
          return { disposition: "settled", action: refreshed };
        }
        if (
          refreshed.state === "retry_scheduled" &&
          refreshed.nextRetryAt &&
          refreshed.nextRetryAt.getTime() > now.getTime()
        ) {
          return { disposition: "deferred", action: refreshed };
        }
        return { disposition: "in_flight", action: refreshed };
      }
      const claimed = mapAction(claimedRow);
      await appendActionEvent(
        tx,
        claimed,
        `dispatch_started:${claimed.dispatchAttempts}`,
        "dispatch_started",
        transitionEventPayload(claimed, "dispatch_started"),
      );
      return { disposition: "claimed", action: claimed };
    });
  }

  async recordDispatchAccepted(
    input: RecordDispatchAcceptedInput,
  ): Promise<ExternalActionRecord> {
    validateDispatchIdentity(input);
    const now = input.now ?? new Date();
    return this.db.transaction(async (tx) => {
      await setTenantContext(tx, input.tenantId, this.context);
      const [updatedRow] = await tx
        .update(externalActions)
        .set({
          state: "dispatched",
          dispatchLeaseOwner: null,
          dispatchLeaseExpiresAt: null,
          nextRetryAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          dispatchReceipt: {
            http_status: input.receipt.httpStatus,
            body: input.receipt.body,
          },
          ...(input.receipt.workflowId
            ? { workflowId: input.receipt.workflowId }
            : {}),
          ...(input.receipt.executionId
            ? { executionId: input.receipt.executionId }
            : {}),
          ...(input.receipt.providerReference
            ? { providerReference: input.receipt.providerReference }
            : {}),
          updatedAt: now,
        })
        .where(
          and(
            eq(externalActions.tenantId, input.tenantId),
            eq(externalActions.actionId, input.actionId),
            eq(externalActions.idempotencyKey, input.idempotencyKey),
            eq(externalActions.state, "dispatching"),
            eq(externalActions.dispatchLeaseOwner, input.leaseOwner),
          ),
        )
        .returning();
      if (!updatedRow) {
        const current = await requireAction(
          tx,
          input.tenantId,
          input.actionId,
          input.idempotencyKey,
        );
        if (isSettled(current.state)) return current;
        throw new ExternalActionStateError(
          `Dispatch lease was lost for external action ${input.actionId}`,
        );
      }
      const accepted = mapAction(updatedRow);
      await appendActionEvent(
        tx,
        accepted,
        `dispatch_accepted:${accepted.dispatchAttempts}`,
        "dispatch_accepted",
        transitionEventPayload(accepted, "dispatch_accepted", {
          http_status: input.receipt.httpStatus,
        }),
      );
      await emitLifecycleOutbox(
        tx,
        accepted,
        "external_action.dispatched.v1",
        `external-action:${accepted.id}:dispatched:${accepted.dispatchAttempts}`,
        { dispatch_receipt: accepted.dispatchReceipt },
      );
      return accepted;
    });
  }

  async scheduleDispatchRetry(
    input: ScheduleDispatchRetryInput,
  ): Promise<ExternalActionRecord> {
    validateDispatchIdentity(input);
    if (input.retryAfterMs <= 0) {
      throw new ExternalActionStateError("retryAfterMs must be positive");
    }
    const now = input.now ?? new Date();
    const nextRetryAt = new Date(now.getTime() + input.retryAfterMs);
    return this.db.transaction(async (tx) => {
      await setTenantContext(tx, input.tenantId, this.context);
      const [updatedRow] = await tx
        .update(externalActions)
        .set({
          state: "retry_scheduled",
          dispatchLeaseOwner: null,
          dispatchLeaseExpiresAt: null,
          nextRetryAt,
          lastErrorCode: input.errorCode ?? "N8N_RETRYABLE_DISPATCH_FAILURE",
          lastErrorMessage: sanitizeErrorMessage(input.errorMessage),
          updatedAt: now,
        })
        .where(
          and(
            eq(externalActions.tenantId, input.tenantId),
            eq(externalActions.actionId, input.actionId),
            eq(externalActions.idempotencyKey, input.idempotencyKey),
            eq(externalActions.state, "dispatching"),
            eq(externalActions.dispatchLeaseOwner, input.leaseOwner),
          ),
        )
        .returning();
      if (!updatedRow) {
        const current = await requireAction(
          tx,
          input.tenantId,
          input.actionId,
          input.idempotencyKey,
        );
        if (isSettled(current.state)) return current;
        throw new ExternalActionStateError(
          `Dispatch lease was lost for external action ${input.actionId}`,
        );
      }
      const retry = mapAction(updatedRow);
      await appendActionEvent(
        tx,
        retry,
        `dispatch_retry_scheduled:${retry.dispatchAttempts}`,
        "dispatch_retry_scheduled",
        transitionEventPayload(retry, "dispatch_retry_scheduled", {
          retry_after: retry.nextRetryAt?.toISOString(),
          error_code: retry.lastErrorCode,
        }),
      );
      await emitLifecycleOutbox(
        tx,
        retry,
        "external_action.retry_scheduled.v1",
        `external-action:${retry.id}:retry:${retry.dispatchAttempts}`,
        {
          retry_at: retry.nextRetryAt?.toISOString(),
          error_code: retry.lastErrorCode,
        },
      );
      return retry;
    });
  }

  async failDispatch(
    input: FailExternalActionDispatchInput,
  ): Promise<ExternalActionRecord> {
    validateDispatchIdentity(input);
    const now = input.now ?? new Date();
    return this.db.transaction(async (tx) => {
      await setTenantContext(tx, input.tenantId, this.context);
      const [updatedRow] = await tx
        .update(externalActions)
        .set({
          state: "failed",
          dispatchLeaseOwner: null,
          dispatchLeaseExpiresAt: null,
          nextRetryAt: null,
          lastErrorCode: input.errorCode ?? "N8N_PERMANENT_DISPATCH_FAILURE",
          lastErrorMessage: sanitizeErrorMessage(input.errorMessage),
          updatedAt: now,
        })
        .where(
          and(
            eq(externalActions.tenantId, input.tenantId),
            eq(externalActions.actionId, input.actionId),
            eq(externalActions.idempotencyKey, input.idempotencyKey),
            eq(externalActions.state, "dispatching"),
            eq(externalActions.dispatchLeaseOwner, input.leaseOwner),
          ),
        )
        .returning();
      if (!updatedRow) {
        const current = await requireAction(
          tx,
          input.tenantId,
          input.actionId,
          input.idempotencyKey,
        );
        if (isSettled(current.state)) return current;
        throw new ExternalActionStateError(
          `Dispatch lease was lost for external action ${input.actionId}`,
        );
      }
      const failed = mapAction(updatedRow);
      await appendActionEvent(
        tx,
        failed,
        `dispatch_failed:${failed.dispatchAttempts}`,
        "dispatch_failed",
        transitionEventPayload(failed, "dispatch_failed", {
          error_code: failed.lastErrorCode,
        }),
      );
      await emitLifecycleOutbox(
        tx,
        failed,
        "external_action.failed.v1",
        `external-action:${failed.id}:failed`,
        { phase: "dispatch", error_code: failed.lastErrorCode },
      );
      await emitFailureIncidentOutbox(tx, failed, "dispatch");
      return failed;
    });
  }

  async recordOutcome(
    inputValue: RecordExternalActionOutcome,
  ): Promise<RecordExternalActionOutcomeResult> {
    const input = recordExternalActionOutcomeSchema.parse(inputValue);
    const now = input.occurredAt ?? new Date();
    const eventKey = `callback:${input.callbackId}`;
    return this.db.transaction(async (tx) => {
      await setTenantContext(tx, input.tenantId, this.context);
      const action = await requireAction(
        tx,
        input.tenantId,
        input.actionId,
        input.idempotencyKey,
      );
      const [existingEvent] = await tx
        .select({ id: externalActionEvents.id })
        .from(externalActionEvents)
        .where(
          and(
            eq(externalActionEvents.tenantId, input.tenantId),
            eq(externalActionEvents.externalActionId, action.id),
            eq(externalActionEvents.eventKey, eventKey),
          ),
        )
        .limit(1);
      if (existingEvent) return { action, isDuplicate: true };

      const completed = input.status === "completed";
      const [updatedRow] = await tx
        .update(externalActions)
        .set({
          state: input.status,
          dispatchLeaseOwner: null,
          dispatchLeaseExpiresAt: null,
          nextRetryAt: null,
          ...(input.workflowId ? { workflowId: input.workflowId } : {}),
          ...(input.executionId ? { executionId: input.executionId } : {}),
          ...(input.providerReference
            ? { providerReference: input.providerReference }
            : {}),
          outcome: input.outcome,
          outcomeReceivedAt: now,
          lastErrorCode: completed
            ? null
            : (input.errorCode ?? "N8N_EXECUTION_FAILED"),
          lastErrorMessage: completed
            ? null
            : sanitizeErrorMessage(
                input.errorMessage ?? "n8n reported a failed action outcome",
              ),
          updatedAt: now,
        })
        .where(
          and(
            eq(externalActions.tenantId, input.tenantId),
            eq(externalActions.actionId, input.actionId),
            eq(externalActions.idempotencyKey, input.idempotencyKey),
            inArray(externalActions.state, callbackEligibleStates),
          ),
        )
        .returning();
      if (!updatedRow) {
        const current = await requireAction(
          tx,
          input.tenantId,
          input.actionId,
          input.idempotencyKey,
        );
        const [duplicateEvent] = await tx
          .select({ id: externalActionEvents.id })
          .from(externalActionEvents)
          .where(
            and(
              eq(externalActionEvents.tenantId, input.tenantId),
              eq(externalActionEvents.externalActionId, current.id),
              eq(externalActionEvents.eventKey, eventKey),
            ),
          )
          .limit(1);
        if (duplicateEvent) return { action: current, isDuplicate: true };
        throw new ExternalActionStateError(
          `Cannot apply a new callback to terminal external action ${input.actionId}`,
        );
      }

      const transitioned = mapAction(updatedRow);
      await appendActionEvent(
        tx,
        transitioned,
        eventKey,
        completed ? "outcome_completed" : "outcome_failed",
        transitionEventPayload(
          transitioned,
          completed ? "outcome_completed" : "outcome_failed",
          {
            callback_id: input.callbackId,
            error_code: transitioned.lastErrorCode,
          },
        ),
      );
      await emitLifecycleOutbox(
        tx,
        transitioned,
        completed
          ? "external_action.completed.v1"
          : "external_action.failed.v1",
        `external-action:${transitioned.id}:${completed ? "completed" : "failed"}:${input.callbackId}`,
        {
          phase: "outcome",
          callback_id: input.callbackId,
          outcome: transitioned.outcome,
          ...(transitioned.lastErrorCode
            ? { error_code: transitioned.lastErrorCode }
            : {}),
        },
      );
      if (!completed)
        await emitFailureIncidentOutbox(tx, transitioned, "outcome");
      return { action: transitioned, isDuplicate: false };
    });
  }

  async getByActionId(
    tenantId: string,
    actionId: string,
  ): Promise<ExternalActionRecord | null> {
    tenantIdSchema.parse(tenantId);
    actionIdSchema.parse(actionId);
    return this.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId, this.context);
      return loadAction(tx, tenantId, actionId);
    });
  }

  async listEvents(
    tenantId: string,
    actionId: string,
  ): Promise<ExternalActionEventRecord[]> {
    tenantIdSchema.parse(tenantId);
    actionIdSchema.parse(actionId);
    return this.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId, this.context);
      const action = await requireAction(tx, tenantId, actionId);
      const rows = await tx
        .select()
        .from(externalActionEvents)
        .where(
          and(
            eq(externalActionEvents.tenantId, tenantId),
            eq(externalActionEvents.externalActionId, action.id),
          ),
        )
        .orderBy(externalActionEvents.createdAt);
      return rows.map(mapActionEvent);
    });
  }
}
