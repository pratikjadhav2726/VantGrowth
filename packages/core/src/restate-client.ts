import { z } from "zod";
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
}
