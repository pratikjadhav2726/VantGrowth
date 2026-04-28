import {
  acceptTenantProvisioningWorkflowDeterministic,
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

    const payload = {
      workflow_id: result.workflowId,
      tenant_id: result.tenantId,
      tenant_external_id: request.tenantExternalId,
      tenant_name: request.tenantName,
      provisioning_key: result.provisioningKey,
      status: result.status,
      accepted_at: result.acceptedAt.toISOString(),
      completed_at: new Date().toISOString(),
    };

    await this.deps.outboxRepository.enqueue({
      tenantId: result.tenantId,
      eventType: "workflow.tenant_provisioning.completed.v1",
      idempotencyKey: `${request.dedupeKey}:completed`,
      payload,
    });

    await this.deps.eventPublisher.publish(
      tenantScopedSubject(
        result.tenantId,
        "workflow.tenant_provisioning.completed.v1",
      ),
      payload,
    );

    return result;
  }
}
