import { z } from "zod";
import { workflowRunStateSchema } from "./workflow-state.js";
import {
  type RestateHelloWorkflowInput,
  type TenantProvisioningWorkflowInput,
  restateHelloWorkflowInputSchema,
  tenantProvisioningWorkflowInputSchema,
} from "./workflows.js";

const restateConfigSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().default(5_000),
});

export type RestateConfig = z.infer<typeof restateConfigSchema>;

export const restateConfigFromEnv = (
  env: Record<string, string | undefined> = process.env,
): RestateConfig | null => {
  const baseUrl = env.RESTATE_BASE_URL;
  if (!baseUrl) return null;

  return restateConfigSchema.parse({
    baseUrl,
    apiKey: env.RESTATE_API_KEY,
    timeoutMs: Number(env.RESTATE_TIMEOUT_MS ?? "5000"),
  });
};

export interface RestateWorkflowClientPort {
  startHelloWorkflow(input: RestateHelloWorkflowInput): Promise<void>;
  startTenantProvisioningWorkflow(
    input: TenantProvisioningWorkflowInput,
  ): Promise<void>;
}

export const tenantProvisioningRuntimeHistoryEventSchema = z.object({
  step: z.string().min(1),
  message: z.string().min(1),
  percent: z.number().min(0).max(100).optional(),
  occurredAt: z.string().datetime(),
});

export type TenantProvisioningRuntimeHistoryEvent = z.infer<
  typeof tenantProvisioningRuntimeHistoryEventSchema
>;

export const tenantProvisioningRuntimeStateSchema = z.object({
  workflowId: z.string().min(1),
  tenantId: z.string().uuid(),
  runtimeRunId: z.string().min(1).optional(),
  state: workflowRunStateSchema,
  history: z.array(tenantProvisioningRuntimeHistoryEventSchema).default([]),
  failureCode: z.string().min(1).optional(),
  failureMessage: z.string().min(1).optional(),
});

export type TenantProvisioningRuntimeState = z.infer<
  typeof tenantProvisioningRuntimeStateSchema
>;

export class RestateHttpWorkflowClient implements RestateWorkflowClientPort {
  constructor(
    private readonly config: RestateConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async post(path: string, payload: Record<string, unknown>) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Restate request timeout")),
      this.config.timeoutMs,
    );

    try {
      const response = await this.fetchFn(
        `${this.config.baseUrl.replace(/\/$/, "")}${path}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.config.apiKey
              ? { authorization: `Bearer ${this.config.apiKey}` }
              : {}),
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        throw new Error(`Restate request failed: ${response.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private async getJson(path: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Restate request timeout")),
      this.config.timeoutMs,
    );

    try {
      const response = await this.fetchFn(
        `${this.config.baseUrl.replace(/\/$/, "")}${path}`,
        {
          method: "GET",
          headers: {
            ...(this.config.apiKey
              ? { authorization: `Bearer ${this.config.apiKey}` }
              : {}),
          },
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        throw new Error(`Restate request failed: ${response.status}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async startHelloWorkflow(input: RestateHelloWorkflowInput): Promise<void> {
    const payload = restateHelloWorkflowInputSchema.parse(input);
    await this.post("/workflows/hello", payload);
  }

  async startTenantProvisioningWorkflow(
    input: TenantProvisioningWorkflowInput,
  ): Promise<void> {
    const payload = tenantProvisioningWorkflowInputSchema.parse(input);
    await this.post("/workflows/tenant-provisioning", payload);
  }

  async getTenantProvisioningRuntimeState(input: {
    tenantId: string;
    workflowId: string;
  }): Promise<TenantProvisioningRuntimeState> {
    const payload = tenantProvisioningWorkflowInputSchema
      .pick({ tenantId: true, workflowId: true })
      .parse(input);
    const response = await this.getJson(
      `/workflows/tenant-provisioning/${encodeURIComponent(payload.workflowId)}/state?tenantId=${encodeURIComponent(payload.tenantId)}`,
    );
    return tenantProvisioningRuntimeStateSchema.parse(response);
  }
}
