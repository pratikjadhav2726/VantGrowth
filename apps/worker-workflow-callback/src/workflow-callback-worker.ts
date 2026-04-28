import {
  acceptTenantProvisioningWorkflowDeterministic,
  createTenantProvisioningCompletedOutboxCommand,
  tenantProvisioningWorkflowInputSchema,
} from "@growthos/core";
import type { OutboxRepository } from "@growthos/db";
import { tenantScopedSubject } from "@growthos/db";

export interface EventPublisher {
  publish(subject: string, payload: Record<string, unknown>): Promise<void>;
}

export interface WorkflowCallbackWorkerDependencies {
  outboxRepository: OutboxRepository;
  eventPublisher: EventPublisher;
}

export class WorkflowCallbackWorker {
  constructor(private readonly deps: WorkflowCallbackWorkerDependencies) {}

  async processTenantProvisioningCompletion(
    input: unknown,
  ): Promise<ReturnType<typeof acceptTenantProvisioningWorkflowDeterministic>> {
    const request = tenantProvisioningWorkflowInputSchema.parse(input);
    const result = acceptTenantProvisioningWorkflowDeterministic(request);
    const command = createTenantProvisioningCompletedOutboxCommand({
      ...request,
      callbackId: "worker-callback",
    });
    await this.deps.outboxRepository.enqueue(command);

    await this.deps.eventPublisher.publish(
      tenantScopedSubject(
        result.tenantId,
        "workflow.tenant_provisioning.completed.v1",
      ),
      command.payload,
    );

    return result;
  }
}
