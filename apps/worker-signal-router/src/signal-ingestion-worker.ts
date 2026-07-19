import { deterministicUuid } from "@growthos/core";
import {
  type OutboxRepository,
  type SignalEventRecord,
  type SignalEventsRepository,
  signalTypeValues,
} from "@growthos/db";
import { z } from "zod";
import type { RoutedSignal } from "./contracts.js";
import { type SignalRouter, classifySignal } from "./signal-router.js";

/**
 * The durable signal-processing loop.
 *
 * `signal_events` is the authoritative inbox. The API only has to durably
 * insert a signal; this worker can safely recover it after a restart, route it
 * through idempotent outbox commands, and mark it processed only once all
 * downstream requests have been persisted.
 */
export const signalRouterRuntimeConfigSchema = z.object({
  tenantIds: z.array(z.string().uuid()).min(1),
  batchSizePerSignalType: z.number().int().positive().max(500).default(50),
  pollIntervalMs: z.number().int().positive().max(60_000).default(1_000),
  claimLeaseMs: z.number().int().min(1_000).max(15 * 60_000).default(60_000),
});

export type SignalRouterRuntimeConfig = z.infer<
  typeof signalRouterRuntimeConfigSchema
>;

export const signalRouterRuntimeConfigFromEnv = (
  env: Record<string, string | undefined> = process.env,
): SignalRouterRuntimeConfig => {
  const tenantIds = (env.SIGNAL_ROUTER_TENANT_IDS ?? env.OUTBOX_TENANT_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return signalRouterRuntimeConfigSchema.parse({
    tenantIds,
    batchSizePerSignalType: Number(
      env.SIGNAL_ROUTER_BATCH_SIZE_PER_SIGNAL_TYPE ?? "50",
    ),
    pollIntervalMs: Number(env.SIGNAL_ROUTER_POLL_INTERVAL_MS ?? "1000"),
    claimLeaseMs: Number(env.SIGNAL_ROUTER_CLAIM_LEASE_MS ?? "60000"),
  });
};

export interface SignalIngestionWorkerDependencies {
  signalEventsRepository: SignalEventsRepository;
  outboxRepository: OutboxRepository;
  signalRouter: SignalRouter;
  /** Stable for this process lifetime; prevents two replicas from double-running a signal. */
  claimOwner?: string;
  claimLeaseMs?: number;
}

export interface SignalProcessingFailure {
  signalId: string;
  error: Error;
}

export interface SignalProcessingResult {
  processedSignalIds: string[];
  failures: SignalProcessingFailure[];
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

/**
 * Experiment lineage may enter through a signed/integrated signal payload.
 * Validate it at the inbox boundary; a later tenant-scoped foreign key still
 * rejects an unknown or cross-tenant experiment when a proposal is persisted.
 */
const resolveExperimentId = (signal: SignalEventRecord): string | undefined => {
  const payload = asRecord(signal.payload);
  const metadata = asRecord(payload.metadata);
  const candidate =
    payload.experiment_id ??
    payload.experimentId ??
    metadata.experiment_id ??
    metadata.experimentId;
  const parsed = z.string().uuid().safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
};

/**
 * Stable RFC-4122-shaped id derived from tenant + signal identity. A signal
 * replay must create the same request ID so downstream outbox idempotency
 * prevents duplicate briefs and content.
 */
export const stableRequestId = deterministicUuid;

export const resolveSignalKind = (signal: SignalEventRecord): string => {
  const payload = asRecord(signal.payload);
  const metadata = asRecord(payload.metadata);
  return (
    nonEmptyString(payload.kind) ??
    nonEmptyString(payload.event_kind) ??
    nonEmptyString(metadata.kind) ??
    `signal.${signal.signalType}`
  );
};

const asDateString = (date: Date): string => date.toISOString().slice(0, 10);

export const createIntelBriefRequestFromSignal = (
  signal: SignalEventRecord,
  routed: RoutedSignal,
) => {
  const requestId = stableRequestId(
    `${signal.tenantId}:intel-brief:${signal.id.toString()}`,
  );
  const kind = resolveSignalKind(signal);
  const experimentId = resolveExperimentId(signal);

  return {
    tenantId: signal.tenantId,
    eventType: "intel_brief.requested.v1",
    idempotencyKey: `intel-brief-request:${signal.id.toString()}`,
    payload: {
      schema_version: "intel_brief_requested.v1",
      request_id: requestId,
      tenant_id: signal.tenantId,
      ...(experimentId ? { experiment_id: experimentId } : {}),
      period_from: asDateString(signal.createdAt),
      period_to: asDateString(signal.createdAt),
      requested_by: "signal_router",
      trigger: {
        signal_id: signal.id.toString(),
        signal_type: signal.signalType,
        source: signal.source,
        kind,
        priority: routed.priority,
        payload: signal.payload,
        occurred_at: signal.createdAt.toISOString(),
      },
    },
  };
};

export const createAgentWorkRequestFromSignal = (
  signal: SignalEventRecord,
  routed: RoutedSignal,
) => ({
  tenantId: signal.tenantId,
  eventType: "agent.work.requested.v1",
  idempotencyKey: `agent-work:${routed.targetAgent}:${signal.id.toString()}`,
  payload: {
    schema_version: "agent_work_requested.v1",
    request_id: stableRequestId(
      `${signal.tenantId}:${routed.targetAgent}:${signal.id.toString()}`,
    ),
    tenant_id: signal.tenantId,
    target_agent: routed.targetAgent,
    signal_id: signal.id.toString(),
    source: signal.source,
    kind: resolveSignalKind(signal),
    priority: routed.priority,
    half_life_minutes: routed.halfLifeMinutes,
    payload: signal.payload,
    requested_at: new Date().toISOString(),
  },
});

export class SignalIngestionWorker {
  private readonly claimOwner: string;
  private readonly claimLeaseMs: number;

  constructor(private readonly deps: SignalIngestionWorkerDependencies) {
    this.claimOwner = deps.claimOwner ?? `signal-router:${crypto.randomUUID()}`;
    this.claimLeaseMs = deps.claimLeaseMs ?? 60_000;
  }

  async processTenant(
    tenantId: string,
    batchSizePerSignalType: number,
  ): Promise<SignalProcessingResult> {
    const processedSignalIds: string[] = [];
    const failures: SignalProcessingFailure[] = [];

    for (const signalType of signalTypeValues) {
      const signals = await this.deps.signalEventsRepository.claimUnprocessed(
        tenantId,
        signalType,
        batchSizePerSignalType,
        { owner: this.claimOwner, leaseMs: this.claimLeaseMs },
      );

      for (const signal of signals) {
        try {
          await this.processSignal(signal);
          processedSignalIds.push(signal.id.toString());
        } catch (rawError) {
          // No side effect is acknowledged on failure. Releasing our lease
          // lets the next bounded poll retry promptly; if this process dies,
          // lease expiry guarantees another replica can recover it.
          await this.deps.signalEventsRepository.releaseClaims(
            signal.tenantId,
            [signal.id],
            this.claimOwner,
          );
          failures.push({
            signalId: signal.id.toString(),
            error:
              rawError instanceof Error
                ? rawError
                : new Error(String(rawError)),
          });
        }
      }
    }

    return { processedSignalIds, failures };
  }

  private async processSignal(signal: SignalEventRecord): Promise<void> {
    const kind = resolveSignalKind(signal);
    const incoming = {
      tenantId: signal.tenantId,
      signalId: signal.id.toString(),
      dedupeKey: `signal:${signal.id.toString()}`,
      source: signal.source,
      kind,
      payload: signal.payload,
    };
    const routed = await this.deps.signalRouter.route(incoming);

    const downstreamCommand =
      routed.targetAgent === "intel_director"
        ? createIntelBriefRequestFromSignal(signal, routed)
        : createAgentWorkRequestFromSignal(signal, routed);
    await this.deps.outboxRepository.enqueue(downstreamCommand);

    // Only advance the authoritative inbox after both the routing decision and
    // the target-agent request are safely in the outbox. Replays are harmless:
    // all commands above have stable, tenant-scoped idempotency keys.
    await this.deps.signalEventsRepository.markProcessed(signal.tenantId, [
      signal.id,
    ]);
  }
}
