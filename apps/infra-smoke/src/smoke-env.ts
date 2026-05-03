import { z } from "zod";

const baseSmokeEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  NATS_SERVERS: z.string().min(1).default("nats://localhost:4222"),
  /** JetStream stream name that stores worker-style subjects (`t.<tenant>.…`). */
  GROWTHOS_JETSTREAM_STREAM: z.string().min(1).default("GROWTHOS"),
  GROWTHOS_SMOKE_TENANT_ID: z
    .string()
    .uuid()
    .default("00000000-0000-4000-8000-000000000001"),
});

export const smokeEnvSchema = baseSmokeEnvSchema
  .extend({
    RESTATE_BASE_URL: z.string().url().optional(),
    RESTATE_API_KEY: z.string().min(1).optional(),
    RESTATE_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
    /** When set with `RESTATE_BASE_URL`, smoke verifies runtime state contract. */
    GROWTHOS_SMOKE_WORKFLOW_ID: z.string().min(1).optional(),
  })
  .superRefine((data, ctx) => {
    const hasBase = Boolean(data.RESTATE_BASE_URL);
    const hasWorkflow = Boolean(data.GROWTHOS_SMOKE_WORKFLOW_ID);
    if (hasBase !== hasWorkflow) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Set both RESTATE_BASE_URL and GROWTHOS_SMOKE_WORKFLOW_ID for Restate smoke, or omit both.",
        path: hasBase ? ["GROWTHOS_SMOKE_WORKFLOW_ID"] : ["RESTATE_BASE_URL"],
      });
    }
  });

export type SmokeEnv = z.infer<typeof smokeEnvSchema>;

export const parseSmokeEnv = (
  env: Record<string, string | undefined> = process.env,
): SmokeEnv => smokeEnvSchema.parse(env);
