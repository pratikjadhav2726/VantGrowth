import { HttpLagoBillingClient, StubBillingClient } from "@growthos/billing";
import {
  type DurableConsumerHandle,
  HttpGiteaProvisioningClient,
  HttpMinioProvisioningClient,
  RestateHttpWorkflowClient,
  StubGiteaProvisioningClient,
  StubMinioProvisioningClient,
  StubNatsProvisioningClient,
  StubPaperclipProvisioningClient,
  restateConfigFromEnv,
  startDurableJetStreamConsumer,
} from "@growthos/core";
import {
  PostgresOutboxRepository,
  PostgresWorkflowRunRepository,
  createDbFromEnv,
} from "@growthos/db";
import { HttpZitadelClient, StubZitadelClient } from "@growthos/identity";
import { createLogger, initOtelSdk } from "@growthos/observability";
import {
  EnvSecretManager,
  TenantSecretsService,
  VaultSecretManager,
} from "@growthos/secrets";
import {
  enqueueWorkflowCallbackDeadLetter,
  parseTenantProvisioningRequestedEvent,
} from "./tenant-provisioning-request.js";
import type { ProvisioningClients } from "./workflow-callback-worker.js";
import { WorkflowCallbackWorker } from "./workflow-callback-worker.js";

const log = createLogger("growthos.worker-workflow-callback");

/**
 * Resolve provisioning clients from environment.
 *
 * Resolution order (all require ENABLE_DIRECT_PROVISIONING=true):
 *   ENABLE_REAL_GITEA_CLIENT=true   → HttpGiteaProvisioningClient (GITEA_BASE_URL + GITEA_TOKEN required)
 *   ENABLE_REAL_MINIO_CLIENT=true   → HttpMinioProvisioningClient (MINIO_ENDPOINT + credentials required)
 *   (default)                       → StubXxxProvisioningClient (tests / local dev without live infra)
 *
 * Paperclip and NATS remain stubs until their corresponding HTTP clients are built.
 */
const resolveProvisioningClients = (): ProvisioningClients | undefined => {
  if (process.env.ENABLE_DIRECT_PROVISIONING !== "true") return undefined;

  const useRealGitea = process.env.ENABLE_REAL_GITEA_CLIENT === "true";
  const useRealMinio = process.env.ENABLE_REAL_MINIO_CLIENT === "true";
  const useRealZitadel = process.env.ENABLE_REAL_ZITADEL_CLIENT === "true";
  const useRealLago = process.env.ENABLE_REAL_LAGO_CLIENT === "true";

  log.info(
    {
      gitea: useRealGitea ? "http" : "stub",
      minio: useRealMinio ? "http" : "stub",
      zitadel: useRealZitadel ? "http" : "stub",
      lago: useRealLago ? "http" : "stub",
    },
    "direct provisioning enabled",
  );

  return {
    zitadel: useRealZitadel
      ? HttpZitadelClient.fromEnv()
      : new StubZitadelClient(),
    billing: useRealLago
      ? HttpLagoBillingClient.fromEnv()
      : new StubBillingClient(),
    paperclip: new StubPaperclipProvisioningClient(),
    gitea: useRealGitea
      ? HttpGiteaProvisioningClient.fromEnv()
      : new StubGiteaProvisioningClient(),
    nats: new StubNatsProvisioningClient(),
    minio: useRealMinio
      ? HttpMinioProvisioningClient.fromEnv()
      : new StubMinioProvisioningClient(),
  };
};

/**
 * Resolve the secrets service from environment.
 *
 * When VAULT_ADDR and VAULT_TOKEN are both set, uses VaultSecretManager
 * (production).  Otherwise uses EnvSecretManager (dev / CI).
 */
const resolveSecretsService = (): TenantSecretsService => {
  const vaultAddr = process.env.VAULT_ADDR;
  const vaultToken = process.env.VAULT_TOKEN;

  if (vaultAddr && vaultToken) {
    log.info({ vaultAddr }, "secrets: using VaultSecretManager");
    const manager = new VaultSecretManager({
      baseUrl: vaultAddr,
      token: vaultToken,
    });
    return new TenantSecretsService(manager);
  }

  log.info("secrets: using EnvSecretManager (no VAULT_ADDR configured)");
  return new TenantSecretsService(new EnvSecretManager());
};

export interface WorkflowCallbackRuntime {
  worker: WorkflowCallbackWorker;
  outboxRepository: PostgresOutboxRepository;
}

/**
 * Builds the worker and the durable outbox used for both lifecycle updates and
 * exhausted-message dead letters. No direct event publisher is created here:
 * the transactional outbox publisher is the only JetStream producer.
 */
export const createWorkflowCallbackRuntimeFromEnv =
  async (): Promise<WorkflowCallbackRuntime> => {
    const db = createDbFromEnv();
    const outboxRepository = new PostgresOutboxRepository(db, {
      actorKind: "system",
    });
    const workflowRunRepository = new PostgresWorkflowRunRepository(db, {
      actorKind: "system",
    });
    const provisioningClients = resolveProvisioningClients();
    const tenantSecretsService = resolveSecretsService();

    // Restate verifier is required only when not running the orchestrator path.
    let runtimeStateVerifier: InstanceType<typeof RestateHttpWorkflowClient>;
    if (!provisioningClients) {
      const restateConfig = restateConfigFromEnv();
      if (!restateConfig) {
        throw new Error(
          "RESTATE_BASE_URL is required when ENABLE_DIRECT_PROVISIONING is not set",
        );
      }
      runtimeStateVerifier = new RestateHttpWorkflowClient(restateConfig);
    } else {
      // Provide a no-op verifier — it will never be called on the orchestrator path.
      runtimeStateVerifier = {
        getTenantProvisioningRuntimeState: async () => {
          throw new Error(
            "Restate verifier is disabled on direct provisioning path",
          );
        },
      } as unknown as InstanceType<typeof RestateHttpWorkflowClient>;
    }

    return {
      outboxRepository,
      worker: new WorkflowCallbackWorker({
        outboxRepository,
        workflowRunRepository,
        runtimeStateVerifier,
        tenantSecretsService,
        ...(provisioningClients ? { provisioningClients } : {}),
      }),
    };
  };

export const createWorkflowCallbackWorkerFromEnv =
  async (): Promise<WorkflowCallbackWorker> =>
    (await createWorkflowCallbackRuntimeFromEnv()).worker;

export const startTenantProvisioningRequestedConsumer = async (
  worker: WorkflowCallbackWorker,
  outboxRepository: PostgresOutboxRepository,
): Promise<DurableConsumerHandle> => {
  const subject =
    process.env.WORKFLOW_CALLBACK_REQUEST_SUBJECT ??
    "t.*.workflow.tenant_provisioning.requested.v1";

  return startDurableJetStreamConsumer(
    {
      servers: process.env.NATS_SERVERS ?? "nats://localhost:4222",
      streamName: process.env.GROWTHOS_JETSTREAM_STREAM ?? "GROWTHOS",
      subject,
      durableName:
        process.env.WORKFLOW_CALLBACK_REQUEST_DURABLE_NAME ??
        "growthos_workflow_callback",
      queueGroup:
        process.env.WORKFLOW_CALLBACK_REQUEST_QUEUE_GROUP ??
        "growthos-worker-workflow-callback",
      clientName:
        process.env.NATS_CLIENT_NAME ?? "growthos-worker-workflow-callback",
      ackWaitMs: Number(
        process.env.WORKFLOW_CALLBACK_REQUEST_ACK_WAIT_MS ?? "60000",
      ),
      maxDeliver: Number(
        process.env.WORKFLOW_CALLBACK_REQUEST_MAX_DELIVER ?? "5",
      ),
      retryDelayMs: Number(
        process.env.WORKFLOW_CALLBACK_REQUEST_RETRY_DELAY_MS ?? "5000",
      ),
      maxAckPending: Number(
        process.env.WORKFLOW_CALLBACK_REQUEST_MAX_ACK_PENDING ?? "25",
      ),
    },
    async (payload, context) => {
      await worker.processTenantProvisioningCompletion(
        parseTenantProvisioningRequestedEvent(payload, context.subject),
      );
    },
    {
      onError: (error, context) => {
        log.error(
          {
            err: error,
            subject: context.subject,
            sequence: context.streamSequence,
            redelivery_count: context.redeliveryCount,
          },
          "tenant provisioning callback processing failed; JetStream will retry",
        );
      },
      onExhausted: async (payload, context, error) =>
        enqueueWorkflowCallbackDeadLetter(
          outboxRepository,
          payload,
          context,
          error,
        ),
    },
  );
};

if (process.env.WORKER_BOOTSTRAP === "true") {
  initOtelSdk({ serviceName: "growthos.worker-workflow-callback" });
  const { worker, outboxRepository } =
    await createWorkflowCallbackRuntimeFromEnv();
  const consumer = await startTenantProvisioningRequestedConsumer(
    worker,
    outboxRepository,
  );
  log.info(
    {
      subject:
        process.env.WORKFLOW_CALLBACK_REQUEST_SUBJECT ??
        "t.*.workflow.tenant_provisioning.requested.v1",
      durable_name:
        process.env.WORKFLOW_CALLBACK_REQUEST_DURABLE_NAME ??
        "growthos_workflow_callback",
    },
    "@growthos/worker-workflow-callback initialized",
  );

  const shutdown = (signal: string) => {
    void consumer.close().finally(() => {
      log.info({ signal }, "workflow callback consumer stopped");
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

export * from "./nats-publisher.js";
export * from "./tenant-provisioning-request.js";
export * from "./workflow-callback-worker.js";
