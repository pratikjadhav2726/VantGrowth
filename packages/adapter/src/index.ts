import { z } from "zod";

export const adapterRunContextSchema = z.object({
  tenantId: z.string().min(1),
  paperclipRunId: z.string().min(1),
  agentId: z.string().min(1),
  issueId: z.string().min(1)
});

export type AdapterRunContext = z.infer<typeof adapterRunContextSchema>;

export interface EventOutboxCommand {
  tenantId: string;
  eventType: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface AdapterPort {
  enqueueOutbox(command: EventOutboxCommand): Promise<{ trackingId: string }>;
}

export class GrowthosNativeAdapter {
  constructor(private readonly port: AdapterPort) {}

  async emitRunStarted(context: AdapterRunContext): Promise<{ trackingId: string }> {
    const parsed = adapterRunContextSchema.parse(context);

    return this.port.enqueueOutbox({
      tenantId: parsed.tenantId,
      eventType: "heartbeat.run.started.v1",
      idempotencyKey: `${parsed.paperclipRunId}:started`,
      payload: {
        run_id: parsed.paperclipRunId,
        agent_id: parsed.agentId,
        issue_id: parsed.issueId
      }
    });
  }
}
