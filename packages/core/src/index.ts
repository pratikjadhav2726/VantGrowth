import { z } from "zod";

export const motionTypeSchema = z.enum([
  "inbound_content",
  "community_engagement",
  "outbound_multichannel",
  "lifecycle_expansion",
  "partners",
  "paid",
  "plg",
  "abm",
]);

export type MotionType = z.infer<typeof motionTypeSchema>;

export const motionScoringInputSchema = z.object({
  tenantId: z.string().min(1),
  productComplexity: z.number().min(0).max(1),
  trialability: z.number().min(0).max(1),
  acvBand: z.number().min(0).max(1),
  salesCycleWeeks: z.number().min(0),
  founderContentCapacity: z.number().min(0).max(1),
  categorySearchDemand: z.number().min(0).max(1),
  communityDensity: z.number().min(0).max(1),
  telemetryReadiness: z.number().min(0).max(1),
  budgetReadiness: z.number().min(0).max(1),
});

export type MotionScoringInput = z.infer<typeof motionScoringInputSchema>;

export const motionScoreResultSchema = z.object({
  scorerVersion: z.literal("motion_scorer.v1"),
  scores: z.record(motionTypeSchema, z.number().min(0).max(1)),
  selectedPrimary: z.array(motionTypeSchema),
  selectedSecondary: z.array(motionTypeSchema),
  rationale: z.array(z.string()),
});

export type MotionScoreResult = z.infer<typeof motionScoreResultSchema>;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

export const scoreMotions = (input: MotionScoringInput): MotionScoreResult => {
  motionScoringInputSchema.parse(input);

  const inbound =
    0.28 * input.categorySearchDemand +
    0.22 * input.founderContentCapacity +
    0.2 * input.telemetryReadiness +
    0.15 * input.trialability +
    0.15 * input.communityDensity;

  const community =
    0.45 * input.communityDensity +
    0.25 * input.founderContentCapacity +
    0.15 * input.telemetryReadiness +
    0.15 * input.budgetReadiness;

  const outbound =
    0.28 * input.acvBand +
    0.22 * clamp01(input.salesCycleWeeks / 12) +
    0.2 * input.telemetryReadiness +
    0.15 * input.budgetReadiness +
    0.15 * input.communityDensity;

  const lifecycle =
    0.35 * input.telemetryReadiness +
    0.25 * input.trialability +
    0.2 * input.productComplexity +
    0.2 * input.budgetReadiness;

  const scoreMap: Record<MotionType, number> = {
    inbound_content: clamp01(inbound),
    community_engagement: clamp01(community),
    outbound_multichannel: clamp01(outbound),
    lifecycle_expansion: clamp01(lifecycle),
    partners: clamp01(
      0.4 * input.acvBand +
        0.3 * input.productComplexity +
        0.3 * input.communityDensity,
    ),
    paid: clamp01(
      0.5 * input.budgetReadiness +
        0.2 * input.categorySearchDemand +
        0.3 * input.trialability,
    ),
    plg: clamp01(0.6 * input.trialability + 0.4 * input.telemetryReadiness),
    abm: clamp01(
      0.6 * input.acvBand + 0.4 * clamp01(input.salesCycleWeeks / 10),
    ),
  };

  const ordered = (
    Object.entries(scoreMap) as Array<[MotionType, number]>
  ).sort((a, b) => b[1] - a[1]);

  return motionScoreResultSchema.parse({
    scorerVersion: "motion_scorer.v1",
    scores: scoreMap,
    selectedPrimary: ordered.slice(0, 2).map(([motion]) => motion),
    selectedSecondary: ordered.slice(2, 4).map(([motion]) => motion),
    rationale: [
      "Scores are deterministic and version-stamped for replayability.",
      "Primary motions are selected by highest weighted fit to current tenant signals.",
    ],
  });
};

export const eventOutboxCommandSchema = z.object({
  tenantId: z.string().min(1),
  eventType: z.string().min(1),
  idempotencyKey: z.string().min(1),
  payload: z.record(z.any()),
});

export type EventOutboxCommand = z.infer<typeof eventOutboxCommandSchema>;

export * from "./adaptive-gtm-harness.js";
export * from "./handoff-contracts.js";
export * from "./provisioning-http-clients.js";
export * from "./restate-client.js";
export * from "./tenant-provisioning.js";
export * from "./workflow-state.js";
export * from "./workflows.js";
