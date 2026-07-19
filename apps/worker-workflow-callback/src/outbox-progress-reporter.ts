/**
 * OutboxProvisioningProgressReporter
 *
 * Bridges the TenantProvisioningOrchestrator's ProvisioningProgressReporter
 * interface to the Postgres outbox. Each call to report() writes a durable
 * progress event; the dedicated outbox publisher is the sole component that
 * later publishes it to JetStream.
 *
 * The callbackId is derived deterministically from (workflowId, step,
 * progressPercent) so that a replayed orchestrator step generates the same
 * idempotency key and the outbox UNIQUE constraint silently drops the duplicate.
 */

import {
  type ProvisioningProgressReporter,
  type ProvisioningStep,
  createTenantProvisioningProgressOutboxCommand,
} from "@growthos/core";
import type { OutboxRepository } from "@growthos/db";

export interface OutboxProgressReporterContext {
  tenantId: string;
  workflowId: string;
  dedupeKey: string;
  tenantExternalId: string;
  tenantName: string;
  requestedBy: string;
}

export class OutboxProvisioningProgressReporter
  implements ProvisioningProgressReporter
{
  constructor(
    private readonly outboxRepository: OutboxRepository,
    private readonly ctx: OutboxProgressReporterContext,
  ) {}

  async report(params: {
    step: ProvisioningStep;
    progressPercent: number;
    message: string;
  }): Promise<void> {
    // Deterministic callbackId: duplicate delivery → same idempotency key →
    // outbox UNIQUE constraint discards the duplicate silently.
    const callbackId = `orchestrator:${this.ctx.workflowId}:${params.step}:${params.progressPercent}`;

    const command = createTenantProvisioningProgressOutboxCommand({
      ...this.ctx,
      callbackId,
      callbackType: "progress",
      runtimeRunId: undefined,
      progressStep: params.step,
      progressMessage: params.message,
      progressPercent: params.progressPercent,
    });

    await this.outboxRepository.enqueue(command);
  }
}
