/**
 * Tenant-provisioning request and dead-letter contracts for the durable
 * JetStream consumer. Keeping this boundary independent of worker bootstrap
 * makes the tenant identity checks testable and prevents payload fields from
 * widening a message's tenant scope.
 */

import { tenantProvisioningWorkflowInputSchema } from "@growthos/core";
import { type OutboxRepository, tenantIdSchema } from "@growthos/db";
import { z } from "zod";

const tenantProvisioningRequestedOutboxPayloadSchema = z.object({
  tenant_id: z.string().uuid().optional(),
  workflow_id: z.string().min(1),
  dedupe_key: z.string().min(1).optional(),
  tenant_external_id: z.string().min(1),
  tenant_name: z.string().min(1),
  requested_by: z.string().min(1),
});

/** Extracts the tenant identity from the trusted tenant-scoped JetStream key. */
export const tenantIdFromTenantScopedSubject = (subject: string): string => {
  const [scope, tenantId] = subject.split(".");
  if (scope !== "t" || !tenantId) {
    throw new Error(`Invalid tenant-scoped workflow subject: ${subject}`);
  }
  return tenantIdSchema.parse(tenantId);
};

/**
 * Outbox events are snake_case payloads and carry their tenant scope in the
 * JetStream subject. Accept canonical messages for compatibility, but never
 * let either payload shape select a different tenant than the subject.
 */
export const parseTenantProvisioningRequestedEvent = (
  payload: Record<string, unknown>,
  subject: string,
) => {
  const tenantId = tenantIdFromTenantScopedSubject(subject);
  const canonical = tenantProvisioningWorkflowInputSchema.safeParse(payload);
  if (canonical.success) {
    if (canonical.data.tenantId !== tenantId) {
      throw new Error(
        "Tenant provisioning payload tenant does not match subject",
      );
    }
    return canonical.data;
  }

  const outboxPayload =
    tenantProvisioningRequestedOutboxPayloadSchema.parse(payload);
  if (outboxPayload.tenant_id && outboxPayload.tenant_id !== tenantId) {
    throw new Error(
      "Tenant provisioning payload tenant does not match subject",
    );
  }
  return tenantProvisioningWorkflowInputSchema.parse({
    tenantId,
    workflowId: outboxPayload.workflow_id,
    // Older requested-event payloads did not carry the original dedupe key.
    // workflowId is stable and the run row is already created by the API.
    dedupeKey: outboxPayload.dedupe_key ?? outboxPayload.workflow_id,
    tenantExternalId: outboxPayload.tenant_external_id,
    tenantName: outboxPayload.tenant_name,
    requestedBy: outboxPayload.requested_by,
  });
};

export const enqueueWorkflowCallbackDeadLetter = async (
  outboxRepository: Pick<OutboxRepository, "enqueue">,
  payload: Record<string, unknown> | null,
  context: {
    subject: string;
    streamSequence: number;
    redeliveryCount: number;
  },
  error: Error,
): Promise<void> => {
  const tenantId = tenantIdFromTenantScopedSubject(context.subject);
  await outboxRepository.enqueue({
    tenantId,
    eventType: "worker.dead_lettered.v1",
    idempotencyKey: `workflow-callback:${context.streamSequence}`,
    payload: {
      worker: "workflow_callback",
      source_subject: context.subject,
      stream_sequence: context.streamSequence,
      redelivery_count: context.redeliveryCount,
      error: error.message,
      failed_payload: payload ?? {},
      occurred_at: new Date().toISOString(),
    },
  });
};
