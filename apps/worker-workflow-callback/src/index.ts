import { HttpLagoBillingClient, StubBillingClient } from "@growthos/billing";
import {
  HttpGiteaProvisioningClient,
  HttpMinioProvisioningClient,
  RestateHttpWorkflowClient,
  StubGiteaProvisioningClient,
  StubMinioProvisioningClient,
  StubNatsProvisioningClient,
  StubPaperclipProvisioningClient,
  restateConfigFromEnv,
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
import { JSONCodec, connect } from "nats";
import { NatsJetStreamPublisher } from "./nats-publisher.js";
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

export const createWorkflowCallbackWorkerFromEnv =
  async (): Promise<WorkflowCallbackWorker> => {
    const db = createDbFromEnv();
    const outboxRepository = new PostgresOutboxRepository(db, {
      actorKind: "system",
    });
    const workflowRunRepository = new PostgresWorkflowRunRepository(db, {
      actorKind: "system",
    });
    const eventPublisher = await NatsJetStreamPublisher.connect();
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

    return new WorkflowCallbackWorker({
      outboxRepository,
      workflowRunRepository,
      eventPublisher,
      runtimeStateVerifier,
      tenantSecretsService,
      ...(provisioningClients ? { provisioningClients } : {}),
    });
  };

const startTenantProvisioningRequestedConsumer = async (
  worker: WorkflowCallbackWorker,
): Promise<void> => {
  const connection = await connect({
    servers: process.env.NATS_SERVERS ?? "nats://localhost:4222",
    name:
      process.env.NATS_CLIENT_NAME ??
      "growthos-worker-workflow-callback-consumer",
  });
  const codec = JSONCodec<Record<string, unknown>>();
  const subject =
    process.env.WORKFLOW_CALLBACK_REQUEST_SUBJECT ??
    "t.*.workflow.tenant_provisioning.requested.v1";
  const queueGroup =
    process.env.WORKFLOW_CALLBACK_QUEUE_GROUP ??
    "growthos-worker-workflow-callback";

  const subscription = connection.subscribe(subject, { queue: queueGroup });
  void (async () => {
    for await (const message of subscription) {
      try {
        await worker.processTenantProvisioningCompletion(
          codec.decode(message.data),
        );
      } catch (error) {
        log.error({ err: error }, "workflow callback processing failed");
      }
    }
  })();
};

if (process.env.WORKER_BOOTSTRAP === "true") {
  initOtelSdk({ serviceName: "growthos.worker-workflow-callback" });
  const worker = await createWorkflowCallbackWorkerFromEnv();
  await startTenantProvisioningRequestedConsumer(worker);
  log.info(
    {
      subject:
        process.env.WORKFLOW_CALLBACK_REQUEST_SUBJECT ??
        "t.*.workflow.tenant_provisioning.requested.v1",
    },
    "@growthos/worker-workflow-callback initialized",
  );
}

export * from "./nats-publisher.js";
export * from "./workflow-callback-worker.js";
