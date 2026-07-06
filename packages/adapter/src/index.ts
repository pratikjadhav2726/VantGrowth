import { z } from "zod";

export const adapterRunContextSchema = z.object({
  tenantId: z.string().min(1),
  paperclipRunId: z.string().min(1),
  agentId: z.string().min(1),
  issueId: z.string().min(1),
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

const paperclipClientConfigSchema = z.object({
  baseUrl: z.string().url(),
  serviceToken: z.string().min(1),
  timeoutMs: z.number().int().positive().default(15_000),
});

export type PaperclipClientConfig = z.infer<typeof paperclipClientConfigSchema>;

export const paperclipEnvSchema = z.object({
  PAPERCLIP_BASE_URL: z.string().url(),
  PAPERCLIP_SERVICE_TOKEN: z.string().min(1),
  PAPERCLIP_TIMEOUT_MS: z.string().regex(/^\d+$/).optional(),
});

export const paperclipConfigFromEnv = (
  env: Record<string, string | undefined>,
): PaperclipClientConfig => {
  const parsed = paperclipEnvSchema.parse(env);
  return paperclipClientConfigSchema.parse({
    baseUrl: parsed.PAPERCLIP_BASE_URL,
    serviceToken: parsed.PAPERCLIP_SERVICE_TOKEN,
    timeoutMs: parsed.PAPERCLIP_TIMEOUT_MS
      ? Number(parsed.PAPERCLIP_TIMEOUT_MS)
      : 15_000,
  });
};

export const paperclipCompanyCreateInputSchema = z.object({
  externalId: z.string().min(1),
  name: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
});
export type PaperclipCompanyCreateInput = z.infer<
  typeof paperclipCompanyCreateInputSchema
>;

export const paperclipCompanySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    // Current Paperclip companies expose `issuePrefix`, not `identifier`.
    identifier: z.string().optional(),
    issuePrefix: z.string().optional(),
  })
  .passthrough();
export type PaperclipCompany = z.infer<typeof paperclipCompanySchema>;

export const paperclipAgentCreateInputSchema = z.object({
  companyId: z.string().min(1),
  name: z.string().min(1),
  role: z.string().min(1),
  title: z.string().min(1),
  adapterType: z.literal("growthos_native"),
  budgetMonthlyCents: z.number().int().nonnegative(),
  capabilities: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type PaperclipAgentCreateInput = z.infer<
  typeof paperclipAgentCreateInputSchema
>;

export const paperclipAgentSchema = z
  .object({
    id: z.string().min(1),
    identifier: z.string().min(1).optional(),
    name: z.string().min(1),
    status: z.string().optional(),
  })
  .passthrough();
export type PaperclipAgent = z.infer<typeof paperclipAgentSchema>;

// New agents in Paperclip require board approval when the company has
// `requireBoardApprovalForNewAgents` enabled (the default). The hire endpoint
// creates the agent in `pending_approval` and returns the linked approval, which
// a human resolves inside Paperclip (the control plane) before the agent runs.
export const paperclipApprovalSchema = z
  .object({
    id: z.string().min(1),
    status: z.string().optional(),
    type: z.string().optional(),
  })
  .passthrough();
export type PaperclipApproval = z.infer<typeof paperclipApprovalSchema>;

export const paperclipAgentHireResultSchema = z.object({
  agent: paperclipAgentSchema,
  approval: paperclipApprovalSchema.nullable().optional(),
});
export type PaperclipAgentHireResult = z.infer<
  typeof paperclipAgentHireResultSchema
>;

export const paperclipIssueCreateInputSchema = z.object({
  companyId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  status: z.string().default("todo"),
  priority: z.string().default("medium"),
  // Optional: a freshly hired agent is `pending_approval` and cannot be
  // assigned work yet, so the seed issue is created unassigned.
  assigneeAgentId: z.string().min(1).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type PaperclipIssueCreateInput = z.input<
  typeof paperclipIssueCreateInputSchema
>;

export const paperclipIssueSchema = z.object({
  id: z.string().min(1),
  identifier: z.string().min(1),
  title: z.string().min(1),
  status: z.string().min(1),
});
export type PaperclipIssue = z.infer<typeof paperclipIssueSchema>;

// Shape returned by the issue-list endpoint (a superset of paperclipIssueSchema).
// Kept lenient so Paperclip can evolve the row without breaking the poller.
export const paperclipIssueListItemSchema = z
  .object({
    id: z.string().min(1),
    identifier: z.string().optional().nullable(),
    title: z.string().optional().nullable(),
    status: z.string().min(1),
    assigneeAgentId: z.string().nullable().optional(),
    companyId: z.string().optional(),
  })
  .passthrough();
export type PaperclipIssueListItem = z.infer<
  typeof paperclipIssueListItemSchema
>;

export const paperclipIssueListSchema = z.array(paperclipIssueListItemSchema);

export const paperclipCheckoutInputSchema = z.object({
  issueId: z.string().min(1),
  agentId: z.string().min(1),
  expectedStatuses: z
    .array(z.string().min(1))
    .default(["todo", "backlog", "blocked", "in_review"]),
  runId: z.string().optional(),
});
export type PaperclipCheckoutInput = z.input<
  typeof paperclipCheckoutInputSchema
>;

export const paperclipWakeupInputSchema = z.object({
  agentId: z.string().min(1),
  source: z.string().min(1),
  triggerDetail: z.string().optional(),
  reason: z.string().min(1),
  payload: z.record(z.unknown()).optional(),
  idempotencyKey: z.string().min(1),
});
export type PaperclipWakeupInput = z.input<typeof paperclipWakeupInputSchema>;

export interface PaperclipClientPort {
  createCompany(input: PaperclipCompanyCreateInput): Promise<PaperclipCompany>;
  createAgent(input: PaperclipAgentCreateInput): Promise<PaperclipAgent>;
  createAgentHire(
    input: PaperclipAgentCreateInput,
  ): Promise<PaperclipAgentHireResult>;
  createIssue(input: PaperclipIssueCreateInput): Promise<PaperclipIssue>;
  listCompanyIssues(
    companyId: string,
    opts?: { limit?: number },
  ): Promise<PaperclipIssueListItem[]>;
  checkoutIssue(input: PaperclipCheckoutInput): Promise<PaperclipIssue>;
  releaseIssue(issueId: string): Promise<void>;
  wakeupAgent(input: PaperclipWakeupInput): Promise<void>;
}

const asJson = async (response: Response): Promise<unknown> => {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return {};
  return response.json();
};

export class PaperclipClient implements PaperclipClientPort {
  constructor(
    private readonly config: PaperclipClientConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.config = paperclipClientConfigSchema.parse(config);
  }

  async createCompany(
    input: PaperclipCompanyCreateInput,
  ): Promise<PaperclipCompany> {
    const body = paperclipCompanyCreateInputSchema.parse(input);
    const result = await this.request("POST", "/api/companies", body);
    return paperclipCompanySchema.parse(result);
  }

  async createAgent(input: PaperclipAgentCreateInput): Promise<PaperclipAgent> {
    const body = paperclipAgentCreateInputSchema.parse(input);
    const result = await this.request(
      "POST",
      `/api/companies/${body.companyId}/agents`,
      body,
    );
    return paperclipAgentSchema.parse(result);
  }

  async createAgentHire(
    input: PaperclipAgentCreateInput,
  ): Promise<PaperclipAgentHireResult> {
    const body = paperclipAgentCreateInputSchema.parse(input);
    const result = await this.request(
      "POST",
      `/api/companies/${body.companyId}/agent-hires`,
      body,
    );
    return paperclipAgentHireResultSchema.parse(result);
  }

  async createIssue(input: PaperclipIssueCreateInput): Promise<PaperclipIssue> {
    const body = paperclipIssueCreateInputSchema.parse(input);
    const result = await this.request(
      "POST",
      `/api/companies/${body.companyId}/issues`,
      body,
    );
    return paperclipIssueSchema.parse(result);
  }

  async listCompanyIssues(
    companyId: string,
    opts: { limit?: number } = {},
  ): Promise<PaperclipIssueListItem[]> {
    const id = z.string().min(1).parse(companyId);
    const limit = opts.limit ?? 100;
    const result = await this.request(
      "GET",
      `/api/companies/${id}/issues?limit=${limit}`,
    );
    // The endpoint may return a bare array or an envelope { items: [...] }.
    const rows = Array.isArray(result)
      ? result
      : ((result as { items?: unknown })?.items ?? []);
    return paperclipIssueListSchema.parse(rows);
  }

  async checkoutIssue(input: PaperclipCheckoutInput): Promise<PaperclipIssue> {
    const body = paperclipCheckoutInputSchema.parse(input);
    const result = await this.request(
      "POST",
      `/api/issues/${body.issueId}/checkout`,
      {
        agentId: body.agentId,
        expectedStatuses: body.expectedStatuses,
      },
      body.runId ? { "X-Paperclip-Run-Id": body.runId } : undefined,
    );
    return paperclipIssueSchema.parse(result);
  }

  async releaseIssue(issueId: string): Promise<void> {
    const parsedIssueId = z.string().min(1).parse(issueId);
    await this.request("POST", `/api/issues/${parsedIssueId}/release`);
  }

  async wakeupAgent(input: PaperclipWakeupInput): Promise<void> {
    const body = paperclipWakeupInputSchema.parse(input);
    await this.request("POST", `/api/agents/${body.agentId}/wakeup`, body);
  }

  private async request(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<unknown> {
    const url = new URL(path, this.config.baseUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await this.fetchImpl(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${this.config.serviceToken}`,
          "Content-Type": "application/json",
          ...headers,
        },
        body: body ? JSON.stringify(body) : null,
        signal: controller.signal,
      });

      if (!response.ok) {
        const payload = await asJson(response);
        throw new Error(
          `Paperclip request failed ${response.status} ${response.statusText}: ${JSON.stringify(payload)}`,
        );
      }

      return asJson(response);
    } finally {
      clearTimeout(timer);
    }
  }
}

export class GrowthosNativeAdapter {
  constructor(private readonly port: AdapterPort) {}

  async emitRunStarted(
    context: AdapterRunContext,
  ): Promise<{ trackingId: string }> {
    const parsed = adapterRunContextSchema.parse(context);

    return this.port.enqueueOutbox({
      tenantId: parsed.tenantId,
      eventType: "heartbeat.run.started.v1",
      idempotencyKey: `${parsed.paperclipRunId}:started`,
      payload: {
        run_id: parsed.paperclipRunId,
        agent_id: parsed.agentId,
        issue_id: parsed.issueId,
      },
    });
  }
}
