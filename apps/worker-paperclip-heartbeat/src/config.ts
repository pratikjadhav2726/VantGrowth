import { z } from "zod";

const tenantIdSchema = z.string().uuid();

const companyTenantMapSchema = z.record(z.string().min(1), tenantIdSchema);

/**
 * Configuration for the Paperclip heartbeat worker.
 *
 * The worker is the GrowthOS-side executor for `growthos_native` agents:
 * Paperclip (the control plane) registers those agents and governs hiring, but
 * delegates execution back to GrowthOS. This worker polls Paperclip for
 * runnable issues assigned to approved agents, claims them, and dispatches the
 * work into the GrowthOS domain workers.
 */
const configSchema = z
  .object({
    paperclip: z.object({
      baseUrl: z.string().url(),
      serviceToken: z.string().min(1),
      timeoutMs: z.number().int().positive().default(15_000),
    }),
    /** Companies this worker is responsible for. Empty = none (worker idles). */
    companyIds: z.array(z.string().min(1)).default([]),
    /**
     * Explicit Paperclip-company → GrowthOS-tenant ownership map.
     *
     * Paperclip company ids are control-plane identifiers and must never be
     * treated as GrowthOS tenant ids. Live dispatch is refused unless every
     * polled company has an explicit UUID tenant mapping.
     */
    companyTenantMap: companyTenantMapSchema.default({}),
    /** How often to poll Paperclip for runnable work. */
    pollIntervalMs: z.number().int().positive().default(15_000),
    /** Issue statuses considered runnable when assigned to an agent. */
    runnableStatuses: z.array(z.string().min(1)).default(["todo", "backlog"]),
    /**
     * When true (the default), the worker only logs the work it *would* run and
     * does NOT mutate Paperclip state. Flip to false to actually check out issues
     * and durably dispatch them through the GrowthOS outbox.
     */
    dryRun: z.boolean().default(true),
  })
  .superRefine((config, ctx) => {
    if (config.dryRun) return;

    for (const companyId of config.companyIds) {
      if (config.companyTenantMap[companyId]) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["companyTenantMap", companyId],
        message:
          "Live Paperclip dispatch requires a GrowthOS tenant mapping for every configured company. Set PAPERCLIP_HEARTBEAT_COMPANY_TENANT_MAP.",
      });
    }
  });

export type PaperclipHeartbeatConfig = z.infer<typeof configSchema>;

const parseBool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) return fallback;
  return value === "true" || value === "1";
};

const parseList = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const parseCompanyTenantMap = (
  value: string | undefined,
): Record<string, string> => {
  if (!value?.trim()) return {};

  try {
    return companyTenantMapSchema.parse(JSON.parse(value));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `PAPERCLIP_HEARTBEAT_COMPANY_TENANT_MAP must be a JSON object mapping Paperclip company ids to GrowthOS tenant UUIDs: ${detail}`,
    );
  }
};

export const configFromEnv = (
  env: Record<string, string | undefined> = process.env,
): PaperclipHeartbeatConfig =>
  configSchema.parse({
    paperclip: {
      baseUrl: env.PAPERCLIP_BASE_URL ?? "",
      serviceToken: env.PAPERCLIP_SERVICE_TOKEN ?? "",
      timeoutMs: env.PAPERCLIP_TIMEOUT_MS
        ? Number(env.PAPERCLIP_TIMEOUT_MS)
        : undefined,
    },
    companyIds: parseList(env.PAPERCLIP_HEARTBEAT_COMPANY_IDS),
    companyTenantMap: parseCompanyTenantMap(
      env.PAPERCLIP_HEARTBEAT_COMPANY_TENANT_MAP,
    ),
    pollIntervalMs: env.PAPERCLIP_HEARTBEAT_POLL_MS
      ? Number(env.PAPERCLIP_HEARTBEAT_POLL_MS)
      : undefined,
    runnableStatuses: env.PAPERCLIP_HEARTBEAT_RUNNABLE_STATUSES
      ? parseList(env.PAPERCLIP_HEARTBEAT_RUNNABLE_STATUSES)
      : undefined,
    dryRun: parseBool(env.PAPERCLIP_HEARTBEAT_DRY_RUN, true),
  });
