import { z } from "zod";

export const restateHelloWorkflowInputSchema = z.object({
  tenantId: z.string().uuid(),
  workflowId: z.string().min(1),
  dedupeKey: z.string().min(1),
  initiatedBy: z.string().min(1),
  message: z.string().min(1),
});

export type RestateHelloWorkflowInput = z.infer<
  typeof restateHelloWorkflowInputSchema
>;

export const restateHelloWorkflowResultSchema = z.object({
  tenantId: z.string().uuid(),
  workflowId: z.string().min(1),
  status: z.literal("completed"),
  responseMessage: z.string().min(1),
  completedAt: z.date(),
});

export type RestateHelloWorkflowResult = z.infer<
  typeof restateHelloWorkflowResultSchema
>;

export const createRestateHelloWorkflowOutboxCommand = (
  input: RestateHelloWorkflowInput,
) => {
  const parsed = restateHelloWorkflowInputSchema.parse(input);
  return {
    tenantId: parsed.tenantId,
    eventType: "workflow.hello.requested.v1",
    idempotencyKey: parsed.dedupeKey,
    payload: {
      workflow_id: parsed.workflowId,
      initiated_by: parsed.initiatedBy,
      message: parsed.message,
      requested_at: new Date().toISOString(),
    },
  };
};

export const runHelloWorkflowDeterministic = (
  input: RestateHelloWorkflowInput,
): RestateHelloWorkflowResult => {
  const parsed = restateHelloWorkflowInputSchema.parse(input);

  return restateHelloWorkflowResultSchema.parse({
    tenantId: parsed.tenantId,
    workflowId: parsed.workflowId,
    status: "completed",
    responseMessage: `Hello ${parsed.initiatedBy}, workflow accepted: ${parsed.message}`,
    completedAt: new Date(),
  });
};

export const tenantProvisioningWorkflowInputSchema = z.object({
  tenantId: z.string().uuid(),
  workflowId: z.string().min(1),
  dedupeKey: z.string().min(1),
  tenantExternalId: z.string().min(1),
  tenantName: z.string().min(1),
  requestedBy: z.string().min(1),
});

export type TenantProvisioningWorkflowInput = z.infer<
  typeof tenantProvisioningWorkflowInputSchema
>;

export const tenantProvisioningWorkflowResultSchema = z.object({
  tenantId: z.string().uuid(),
  workflowId: z.string().min(1),
  status: z.literal("accepted"),
  provisioningKey: z.string().min(1),
  acceptedAt: z.date(),
});

export type TenantProvisioningWorkflowResult = z.infer<
  typeof tenantProvisioningWorkflowResultSchema
>;

export const createTenantProvisioningWorkflowOutboxCommand = (
  input: TenantProvisioningWorkflowInput,
) => {
  const parsed = tenantProvisioningWorkflowInputSchema.parse(input);
  return {
    tenantId: parsed.tenantId,
    eventType: "workflow.tenant_provisioning.requested.v1",
    idempotencyKey: parsed.dedupeKey,
    payload: {
      workflow_id: parsed.workflowId,
      tenant_external_id: parsed.tenantExternalId,
      tenant_name: parsed.tenantName,
      requested_by: parsed.requestedBy,
      requested_at: new Date().toISOString(),
    },
  };
};

export const acceptTenantProvisioningWorkflowDeterministic = (
  input: TenantProvisioningWorkflowInput,
): TenantProvisioningWorkflowResult => {
  const parsed = tenantProvisioningWorkflowInputSchema.parse(input);

  return tenantProvisioningWorkflowResultSchema.parse({
    tenantId: parsed.tenantId,
    workflowId: parsed.workflowId,
    status: "accepted",
    provisioningKey: `${parsed.tenantExternalId}:${parsed.dedupeKey}`,
    acceptedAt: new Date(),
  });
};

export const tenantProvisioningRuntimeCallbackSchema =
  tenantProvisioningWorkflowInputSchema.extend({
    callbackId: z.string().min(1),
    runtimeRunId: z.string().min(1).optional(),
    progressStep: z.string().min(1).optional(),
    progressMessage: z.string().min(1).optional(),
    progressPercent: z.number().min(0).max(100).optional(),
  });

export type TenantProvisioningRuntimeCallback = z.infer<
  typeof tenantProvisioningRuntimeCallbackSchema
>;

export const createTenantProvisioningCompletedOutboxCommand = (
  input: TenantProvisioningRuntimeCallback,
) => {
  const parsed = tenantProvisioningRuntimeCallbackSchema.parse(input);
  const accepted = acceptTenantProvisioningWorkflowDeterministic(parsed);

  return {
    tenantId: parsed.tenantId,
    eventType: "workflow.tenant_provisioning.completed.v1",
    idempotencyKey: `${parsed.dedupeKey}:completed:${parsed.callbackId}`,
    payload: {
      workflow_id: accepted.workflowId,
      tenant_id: accepted.tenantId,
      tenant_external_id: parsed.tenantExternalId,
      tenant_name: parsed.tenantName,
      provisioning_key: accepted.provisioningKey,
      status: accepted.status,
      callback_id: parsed.callbackId,
      runtime_run_id: parsed.runtimeRunId ?? null,
      accepted_at: accepted.acceptedAt.toISOString(),
      completed_at: new Date().toISOString(),
    },
  };
};

export const createTenantProvisioningProgressOutboxCommand = (
  input: TenantProvisioningRuntimeCallback,
) => {
  const parsed = tenantProvisioningRuntimeCallbackSchema.parse(input);

  return {
    tenantId: parsed.tenantId,
    eventType: "workflow.tenant_provisioning.progress.v1",
    idempotencyKey: `${parsed.dedupeKey}:progress:${parsed.callbackId}:${parsed.progressStep ?? "callback_received"}`,
    payload: {
      workflow_id: parsed.workflowId,
      tenant_id: parsed.tenantId,
      tenant_external_id: parsed.tenantExternalId,
      tenant_name: parsed.tenantName,
      callback_id: parsed.callbackId,
      runtime_run_id: parsed.runtimeRunId ?? null,
      progress_step: parsed.progressStep ?? "callback_received",
      progress_message: parsed.progressMessage ?? "Runtime callback received",
      progress_percent: parsed.progressPercent ?? null,
      occurred_at: new Date().toISOString(),
    },
  };
};
