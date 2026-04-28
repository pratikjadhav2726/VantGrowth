import { PostgresOutboxRepository, createDbFromEnv } from "@growthos/db";
import { NatsJetStreamPublisher } from "./nats-publisher.js";
import { WorkflowCallbackWorker } from "./workflow-callback-worker.js";

export const createWorkflowCallbackWorkerFromEnv =
  async (): Promise<WorkflowCallbackWorker> => {
    const outboxRepository = new PostgresOutboxRepository(
      createDbFromEnv(),
      {
        actorKind: "system",
      },
    );
    const eventPublisher = await NatsJetStreamPublisher.connect();

    return new WorkflowCallbackWorker({
      outboxRepository,
      eventPublisher,
    });
  };

if (process.env.WORKER_BOOTSTRAP === "true") {
  await createWorkflowCallbackWorkerFromEnv();
  console.log("@growthos/worker-workflow-callback initialized");
}

export * from "./nats-publisher.js";
export * from "./workflow-callback-worker.js";
