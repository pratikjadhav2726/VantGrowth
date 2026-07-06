import { z } from "zod";

/**
 * Configuration for the Paperclip heartbeat worker.
 *
 * The worker is the GrowthOS-side executor for `growthos_native` agents:
 * Paperclip (the control plane) registers those agents and governs hiring, but
 * delegates execution back to GrowthOS. This worker polls Paperclip for
 * runnable issues assigned to approved agents, claims them, and dispatches the
 * work into the GrowthOS domain workers.
 */
const configSchema = z.object({
  paperclip: z.object({
    baseUrl: z.string().url(),
    serviceToken: z.string().min(1),
    timeoutMs: z.number().int().positive().default(15_000),
  }),
  /** Companies this worker is responsible for. Empty = none (worker idles). */
  companyIds: z.array(z.string().min(1)).default([]),
  /** How often to poll Paperclip for runnable work. */
  pollIntervalMs: z.number().int().positive().default(15_000),
  /** Issue statuses considered runnable when assigned to an agent. */
  runnableStatuses: z.array(z.string().min(1)).default(["todo", "backlog"]),
  /**
   * When true (the default), the worker only logs the work it *would* run and
   * does NOT mutate Paperclip state. Flip to false to actually check out issues
   * and dispatch them. Keeps the scaffold safe to run before the domain
   * dispatch is fully wired.
   */
  dryRun: z.boolean().default(true),
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
    pollIntervalMs: env.PAPERCLIP_HEARTBEAT_POLL_MS
      ? Number(env.PAPERCLIP_HEARTBEAT_POLL_MS)
      : undefined,
    runnableStatuses: env.PAPERCLIP_HEARTBEAT_RUNNABLE_STATUSES
      ? parseList(env.PAPERCLIP_HEARTBEAT_RUNNABLE_STATUSES)
      : undefined,
    dryRun: parseBool(env.PAPERCLIP_HEARTBEAT_DRY_RUN, true),
  });
