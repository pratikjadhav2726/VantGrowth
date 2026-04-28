import {
  RestateHttpWorkflowClient,
  restateConfigFromEnv,
} from "@growthos/core";
import {
  PostgresOutboxRepository,
  PostgresWorkflowRunRepository,
  createDbFromEnv,
} from "@growthos/db";
import { JSONCodec, connect } from "nats";
import { NatsJetStreamPublisher } from "./nats-publisher.js";
import { WorkflowCallbackWorker } from "./workflow-callback-worker.js";

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
    const restateConfig = restateConfigFromEnv();
    if (!restateConfig) {
      throw new Error(
        "RESTATE_BASE_URL is required for worker-workflow-callback runtime verification",
      );
    }
    const runtimeStateVerifier = new RestateHttpWorkflowClient(restateConfig);

    return new WorkflowCallbackWorker({
      outboxRepository,
      workflowRunRepository,
      eventPublisher,
      runtimeStateVerifier,
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
        console.error("workflow callback processing failed", error);
      }
    }
  })();
};

if (process.env.WORKER_BOOTSTRAP === "true") {
  const worker = await createWorkflowCallbackWorkerFromEnv();
  await startTenantProvisioningRequestedConsumer(worker);
  console.log("@growthos/worker-workflow-callback initialized");
}

export * from "./nats-publisher.js";
export * from "./workflow-callback-worker.js";
