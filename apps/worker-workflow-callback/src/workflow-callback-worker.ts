import {
  type TenantProvisioningRuntimeHistoryEvent,
  type TenantProvisioningRuntimeState,
  createTenantProvisioningCompletedOutboxCommand,
  createTenantProvisioningFailedOutboxCommand,
  createTenantProvisioningProgressOutboxCommand,
  tenantProvisioningWorkflowInputSchema,
} from "@growthos/core";
import type { OutboxRepository, WorkflowRunRepository } from "@growthos/db";
import { tenantScopedSubject } from "@growthos/db";

export interface EventPublisher {
  publish(subject: string, payload: Record<string, unknown>): Promise<void>;
}

export interface RuntimeStateVerifier {
  getTenantProvisioningRuntimeState(input: {
    tenantId: string;
    workflowId: string;
  }): Promise<TenantProvisioningRuntimeState>;
}

export interface WorkflowCallbackWorkerDependencies {
  outboxRepository: OutboxRepository;
  workflowRunRepository: WorkflowRunRepository;
  eventPublisher: EventPublisher;
  runtimeStateVerifier: RuntimeStateVerifier;
}

export class WorkflowCallbackWorker {
  constructor(private readonly deps: WorkflowCallbackWorkerDependencies) {}

  private async emitProgressEvent(
    request: {
      tenantId: string;
      workflowId: string;
      dedupeKey: string;
      tenantExternalId: string;
      tenantName: string;
      requestedBy: string;
    },
    callbackId: string,
    runtimeRunId: string | undefined,
    event: TenantProvisioningRuntimeHistoryEvent,
  ): Promise<void> {
    const command = createTenantProvisioningProgressOutboxCommand({
      ...request,
      callbackId,
      callbackType: "progress",
      runtimeRunId,
      progressStep: event.step,
      progressMessage: event.message,
      progressPercent: event.percent,
    });
    await this.deps.outboxRepository.enqueue(command);
    await this.deps.eventPublisher.publish(
      tenantScopedSubject(
        request.tenantId,
        "workflow.tenant_provisioning.progress.v1",
      ),
      command.payload,
    );
  }

  async processTenantProvisioningCompletion(
    input: unknown,
  ): Promise<TenantProvisioningRuntimeState> {
    const request = tenantProvisioningWorkflowInputSchema.parse(input);
    const callbackId = `worker-callback:${request.workflowId}`;
    const currentRun = await this.deps.workflowRunRepository.upsertRequested(
      request.tenantId,
      request.workflowId,
      request.dedupeKey,
    );

    // If already terminal, return deterministic result without re-emitting.
    if (currentRun.state === "completed" || currentRun.state === "failed") {
      return this.deps.runtimeStateVerifier.getTenantProvisioningRuntimeState({
        tenantId: request.tenantId,
        workflowId: request.workflowId,
      });
    }

    if (currentRun.state === "requested") {
      await this.deps.workflowRunRepository.transitionState(
        request.tenantId,
        request.workflowId,
        "requested",
        "in_progress",
      );
    }

    const runtimeState =
      await this.deps.runtimeStateVerifier.getTenantProvisioningRuntimeState({
        tenantId: request.tenantId,
        workflowId: request.workflowId,
      });

    for (const historyEvent of runtimeState.history) {
      await this.emitProgressEvent(
        request,
        callbackId,
        runtimeState.runtimeRunId,
        historyEvent,
      );
    }

    if (runtimeState.state === "completed") {
      const completedCommand = createTenantProvisioningCompletedOutboxCommand({
        ...request,
        callbackId,
        callbackType: "completed",
        runtimeRunId: runtimeState.runtimeRunId,
      });
      await this.deps.outboxRepository.enqueue(completedCommand);
      await this.deps.eventPublisher.publish(
        tenantScopedSubject(
          request.tenantId,
          "workflow.tenant_provisioning.completed.v1",
        ),
        completedCommand.payload,
      );
      await this.deps.workflowRunRepository.transitionState(
        request.tenantId,
        request.workflowId,
        "in_progress",
        "completed",
      );
      return runtimeState;
    }

    if (runtimeState.state === "failed") {
      const failedCommand = createTenantProvisioningFailedOutboxCommand({
        ...request,
        callbackId,
        callbackType: "failed",
        runtimeRunId: runtimeState.runtimeRunId,
        failureCode: runtimeState.failureCode,
        failureMessage: runtimeState.failureMessage,
      });
      await this.deps.outboxRepository.enqueue(failedCommand);
      await this.deps.eventPublisher.publish(
        tenantScopedSubject(
          request.tenantId,
          "workflow.tenant_provisioning.failed.v1",
        ),
        failedCommand.payload,
      );
      await this.deps.workflowRunRepository.transitionState(
        request.tenantId,
        request.workflowId,
        "in_progress",
        "failed",
        runtimeState.failureCode,
      );
      return runtimeState;
    }

    throw new Error(
      `Runtime state '${runtimeState.state}' is not terminal for workflow callback completion`,
    );
  }
}
