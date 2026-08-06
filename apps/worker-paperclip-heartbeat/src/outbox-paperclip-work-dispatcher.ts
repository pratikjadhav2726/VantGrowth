import {
  GrowthosNativeAdapter,
  type PaperclipWorkReadyContext,
} from "@growthos/adapter";
import type { OutboxRepository } from "@growthos/db";
import type {
  DispatchContext,
  Dispatcher,
} from "./paperclip-heartbeat-worker.js";

/**
 * Durable Paperclip → GrowthOS dispatch boundary.
 *
 * The heartbeat worker first claims an issue in Paperclip, then this dispatcher
 * persists `paperclip.work.ready.v1` in the tenant-scoped outbox. The separate
 * outbox publisher is responsible for forwarding that row to
 * `t.<tenant>.paperclip.work.ready.v1` on JetStream and marking it consumed.
 *
 * This class intentionally does not publish directly: a successful checkout
 * must never be lost because NATS is temporarily unavailable.
 */
export class OutboxPaperclipWorkDispatcher {
  private readonly adapter: GrowthosNativeAdapter;

  constructor(outboxRepository: OutboxRepository) {
    this.adapter = new GrowthosNativeAdapter({
      enqueueOutbox: async (command) => {
        const event = await outboxRepository.enqueue(command);
        return { trackingId: event.id };
      },
    });
  }

  async dispatch(ctx: DispatchContext): Promise<void> {
    const context: PaperclipWorkReadyContext = {
      tenantId: ctx.tenantId,
      paperclipCompanyId: ctx.companyId,
      paperclipRunId: ctx.runId,
      agentId: ctx.agentId,
      issueId: ctx.issueId,
      issueIdentifier: ctx.issueIdentifier,
      issueTitle: ctx.title,
    };

    await this.adapter.emitWorkReady(context);
  }

  asDispatcher(): Dispatcher {
    return (ctx) => this.dispatch(ctx);
  }
}
