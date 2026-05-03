/**
 * WorkflowCallbackWorker
 *
 * Processes tenant provisioning workflow callbacks arriving via NATS.
 * Supports two execution paths:
 *
 *   1. Direct (orchestrator) path — preferred for Phase 1 local runs.
 *      Enabled by injecting `provisioningClients` into the constructor.
 *      The worker creates a TenantProvisioningOrchestrator per request,
 *      wires in an OutboxProvisioningProgressReporter, runs the 5 idempotent
 *      provisioning steps, and emits the terminal event when complete.
 *
 *   2. Restate verification path — production path for when Restate
 *      is the durable executor (runtimeStateVerifier is non-null).
 *      The worker queries Restate for current state, replays history events
 *      through the outbox, and emits the terminal event.
 *
 * Both paths are idempotent: if the workflow_runs row is already terminal,
 * the worker returns immediately without re-emitting events.
 */

import {
  type GiteaProvisioningClient,
  type MinioProvisioningClient,
  type NatsProvisioningClient,
  type PaperclipProvisioningClient,
  TenantProvisioningOrchestrator,
  type TenantProvisioningRuntimeHistoryEvent,
  type TenantProvisioningRuntimeState,
  createTenantProvisioningCompletedOutboxCommand,
  createTenantProvisioningFailedOutboxCommand,
  createTenantProvisioningProgressOutboxCommand,
  tenantProvisioningWorkflowInputSchema,
} from "@growthos/core";
import type { ZitadelClient } from "@growthos/identity";
import type { BillingClient } from "@growthos/billing";
import type { OutboxRepository, WorkflowRunRepository } from "@growthos/db";
import { tenantScopedSubject } from "@growthos/db";
import type { TenantSecretsService } from "@growthos/secrets";
import { OutboxProvisioningProgressReporter } from "./outbox-progress-reporter.js";

export interface EventPublisher {
  publish(subject: string, payload: Record<string, unknown>): Promise<void>;
}

export interface RuntimeStateVerifier {
  getTenantProvisioningRuntimeState(input: {
    tenantId: string;
    workflowId: string;
  }): Promise<TenantProvisioningRuntimeState>;
}

/** External system clients needed by the orchestrator for direct provisioning. */
export interface ProvisioningClients {
  zitadel: ZitadelClient;
  billing: BillingClient;
  paperclip: PaperclipProvisioningClient;
  gitea: GiteaProvisioningClient;
  nats: NatsProvisioningClient;
  minio: MinioProvisioningClient;
}

export interface WorkflowCallbackWorkerDependencies {
  outboxRepository: OutboxRepository;
  workflowRunRepository: WorkflowRunRepository;
  eventPublisher: EventPublisher;
  runtimeStateVerifier: RuntimeStateVerifier;
  /**
   * When provided the worker executes provisioning steps directly without
   * delegating to Restate.  Each request gets a fresh orchestrator instance
   * with a request-scoped OutboxProvisioningProgressReporter.
   */
  provisioningClients?: ProvisioningClients;
  /**
   * Optional: when provided, the worker writes well-known tenant secrets
   * (openai_api_key, nats_credentials, etc.) to the secrets store immediately
   * after the 5 provisioning steps complete.  Secrets are sourced from
   * matching environment variables so the provisioning flow is fully
   * automated in CI without manual Vault writes.
   *
   * In production replace the env-backed SecretManager with VaultSecretManager
   * by setting VAULT_ADDR + VAULT_TOKEN.
   */
  tenantSecretsService?: TenantSecretsService;
}

export class WorkflowCallbackWorker {
  constructor(private readonly deps: WorkflowCallbackWorkerDependencies) {}

  // ---------------------------------------------------------------------------
  // Direct orchestrator path (Phase 1 / no-Restate)
  // ---------------------------------------------------------------------------

  private async processWithOrchestrator(
    request: ReturnType<typeof tenantProvisioningWorkflowInputSchema.parse>,
    clients: ProvisioningClients,
  ): Promise<TenantProvisioningRuntimeState> {
    const currentRun = await this.deps.workflowRunRepository.upsertRequested(
      request.tenantId,
      request.workflowId,
      request.dedupeKey,
    );

    // Already terminal — return cached state, no re-emission.
    if (currentRun.state === "completed" || currentRun.state === "failed") {
      return {
        workflowId: request.workflowId,
        tenantId: request.tenantId,
        state: currentRun.state,
        failureCode: currentRun.failureCode ?? undefined,
        history: [],
      };
    }

    if (currentRun.state === "requested") {
      await this.deps.workflowRunRepository.transitionState(
        request.tenantId,
        request.workflowId,
        "requested",
        "in_progress",
      );
    }

    const reporter = new OutboxProvisioningProgressReporter(
      this.deps.outboxRepository,
      this.deps.eventPublisher,
      {
        tenantId: request.tenantId,
        workflowId: request.workflowId,
        dedupeKey: request.dedupeKey,
        tenantExternalId: request.tenantExternalId,
        tenantName: request.tenantName,
        requestedBy: request.requestedBy,
      },
    );

    const orchestrator = new TenantProvisioningOrchestrator({
      ...clients,
      progress: reporter,
    });

    try {
      const result = await orchestrator.run(request);

      // ── Step 6 (optional): write well-known secrets to the secrets store ──
      // Sources from matching env vars; silently skips missing vars.  This
      // step is idempotent: re-provisioning the same tenant overwrites
      // existing secrets with the current env values.
      if (this.deps.tenantSecretsService) {
        await this.deps.tenantSecretsService.provisionTenant(request.tenantId, {
          openai_api_key: process.env.TENANT_OPENAI_API_KEY ?? "",
          paperclip_api_token: process.env.PAPERCLIP_SERVICE_TOKEN ?? "",
          gitea_token: process.env.GITEA_SERVICE_TOKEN ?? "",
          minio_access_key: process.env.MINIO_ACCESS_KEY ?? "",
          minio_secret_key: process.env.MINIO_SECRET_KEY ?? "",
          nats_credentials: process.env.NATS_CREDENTIALS ?? "",
        });
      }

      const callbackId = `orchestrator:${request.workflowId}:completed`;
      const completedCommand = createTenantProvisioningCompletedOutboxCommand({
        ...request,
        callbackId,
        callbackType: "completed",
        runtimeRunId: undefined,
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

      // Build synthetic runtime state from orchestrator result.
      const history: TenantProvisioningRuntimeHistoryEvent[] = result.steps.map(
        (s) => ({
          step: s.step,
          message: s.skipped
            ? `${s.step} skipped (already exists)`
            : `${s.step} completed`,
          percent: undefined,
          occurredAt: result.completedAt,
        }),
      );

      return {
        workflowId: result.workflowId,
        tenantId: result.tenantId,
        state: "completed",
        history,
      };
    } catch (err) {
      const failureMessage =
        err instanceof Error ? err.message : "Unknown provisioning failure";
      const failureCode = "PROVISIONING_ERROR";

      const callbackId = `orchestrator:${request.workflowId}:failed`;
      const failedCommand = createTenantProvisioningFailedOutboxCommand({
        ...request,
        callbackId,
        callbackType: "failed",
        runtimeRunId: undefined,
        failureCode,
        failureMessage,
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
        failureCode,
      );

      return {
        workflowId: request.workflowId,
        tenantId: request.tenantId,
        state: "failed",
        failureCode,
        failureMessage,
        history: [],
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Restate verification path
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async processTenantProvisioningCompletion(
    input: unknown,
  ): Promise<TenantProvisioningRuntimeState> {
    const request = tenantProvisioningWorkflowInputSchema.parse(input);

    // Prefer direct orchestrator path when provisioning clients are injected.
    if (this.deps.provisioningClients) {
      return this.processWithOrchestrator(
        request,
        this.deps.provisioningClients,
      );
    }

    // ── Restate verification path (legacy / production Restate setup) ──────
    const callbackId = `worker-callback:${request.workflowId}`;
    const currentRun = await this.deps.workflowRunRepository.upsertRequested(
      request.tenantId,
      request.workflowId,
      request.dedupeKey,
    );

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
