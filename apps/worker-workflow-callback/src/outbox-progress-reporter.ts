/**
 * OutboxProvisioningProgressReporter
 *
 * Bridges the TenantProvisioningOrchestrator's ProvisioningProgressReporter
 * interface to the Postgres outbox + NATS event pipeline.  Each call to
 * report() enqueues a progress event in the outbox (durable) and publishes it
 * immediately to the NATS subject (live push), ensuring idempotent delivery
 * when the NATS message is re-delivered on retry.
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
import { tenantScopedSubject } from "@growthos/db";
import type { EventPublisher } from "./workflow-callback-worker.js";

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
    private readonly eventPublisher: EventPublisher,
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
    await this.eventPublisher.publish(
      tenantScopedSubject(
        this.ctx.tenantId,
        "workflow.tenant_provisioning.progress.v1",
      ),
      command.payload,
    );
  }
}
