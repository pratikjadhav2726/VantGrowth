import { z } from "zod";

/**
 * Product-agnostic context used by every GTM agent. Keeping this contract in
 * core prevents individual workers from inventing incompatible assumptions
 * about the product, buyer, funnel, success metrics, or autonomy boundaries.
 */
export const gtmProductProfileSchema = z.object({
  schemaVersion: z.literal("gtm_product_profile.v1"),
  tenantId: z.string().uuid(),
  product: z.object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().min(20).max(8_000),
    category: z.string().trim().min(1).max(200),
    businessModel: z.enum([
      "b2b_saas",
      "b2c_saas",
      "marketplace",
      "usage_based",
      "services",
      "hybrid",
      "other",
    ]),
    salesMotion: z.enum([
      "self_serve",
      "sales_assisted",
      "enterprise",
      "channel",
      "hybrid",
    ]),
    valuePropositions: z
      .array(z.string().trim().min(1).max(500))
      .min(1)
      .max(12),
    proofPoints: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  }),
  audiences: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(100),
        name: z.string().trim().min(1).max(200),
        pains: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
        desiredOutcomes: z
          .array(z.string().trim().min(1).max(500))
          .min(1)
          .max(20),
        buyingTriggers: z
          .array(z.string().trim().min(1).max(500))
          .max(20)
          .default([]),
        exclusions: z
          .array(z.string().trim().min(1).max(500))
          .max(20)
          .default([]),
      }),
    )
    .min(1)
    .max(20),
  funnel: z.object({
    awarenessEvent: z.string().trim().min(1).max(200),
    activationEvent: z.string().trim().min(1).max(200),
    conversionEvent: z.string().trim().min(1).max(200),
    retentionEvent: z.string().trim().min(1).max(200),
    salesCycleDays: z.number().int().nonnegative().max(3_650),
  }),
  goals: z
    .array(
      z.object({
        metric: z.string().trim().min(1).max(200),
        direction: z.enum(["increase", "decrease"]),
        target: z.number().finite(),
        horizonDays: z.number().int().positive().max(3_650),
      }),
    )
    .min(1)
    .max(20),
  constraints: z.object({
    monthlyBudget: z.number().nonnegative(),
    currencies: z.array(z.string().length(3)).min(1).max(10),
    prohibitedClaims: z.array(z.string().trim().min(1).max(500)).max(100),
    prohibitedChannels: z.array(z.string().trim().min(1).max(100)).max(50),
    regulatedIndustry: z.boolean(),
  }),
});

export type GtmProductProfile = z.infer<typeof gtmProductProfileSchema>;

export const changeRiskSchema = z.enum(["low", "medium", "high", "critical"]);
export type ChangeRisk = z.infer<typeof changeRiskSchema>;

export const adaptiveLearningPolicySchema = z.object({
  minEvidence: z.number().int().positive().default(20),
  minUniqueEntities: z.number().int().positive().default(5),
  minConfidence: z.number().min(0).max(1).default(0.8),
  minRelativeLift: z.number().positive().default(0.05),
  maxGuardrailRegression: z.number().min(0).max(1).default(0.02),
  humanApprovalFor: z.array(changeRiskSchema).default(["high", "critical"]),
});

export type AdaptiveLearningPolicy = z.infer<
  typeof adaptiveLearningPolicySchema
>;

export const learningProposalEvaluationSchema = z.object({
  proposalId: z.string().min(1),
  risk: changeRiskSchema,
  evidenceCount: z.number().int().nonnegative(),
  uniqueEntities: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1),
  metricDirection: z.enum(["increase", "decrease"]),
  baselineMetric: z.number().finite(),
  candidateMetric: z.number().finite(),
  /** Positive means a guardrail became worse. */
  worstGuardrailRegression: z.number().min(0).max(1),
  humanApproved: z.boolean().default(false),
});

export type LearningProposalEvaluation = z.infer<
  typeof learningProposalEvaluationSchema
>;

export const learningDecisionSchema = z.object({
  decision: z.enum([
    "continue_experiment",
    "reject",
    "requires_approval",
    "promote",
  ]),
  relativeLift: z.number(),
  reasons: z.array(z.string().min(1)).min(1),
});

export type LearningDecision = z.infer<typeof learningDecisionSchema>;

/**
 * Deterministic promotion gate. It deliberately does not infer causality from
 * a single approval, critique, or conversion: a candidate must be measured
 * across enough independent entities and pass business guardrails.
 */
export const evaluateLearningProposal = (
  input: LearningProposalEvaluation,
  rawPolicy: Partial<AdaptiveLearningPolicy> = {},
): LearningDecision => {
  const evaluation = learningProposalEvaluationSchema.parse(input);
  const policy = adaptiveLearningPolicySchema.parse(rawPolicy);
  const denominator = Math.max(Math.abs(evaluation.baselineMetric), 1e-9);
  const improvement =
    evaluation.metricDirection === "increase"
      ? evaluation.candidateMetric - evaluation.baselineMetric
      : evaluation.baselineMetric - evaluation.candidateMetric;
  const relativeLift = improvement / denominator;

  if (evaluation.worstGuardrailRegression > policy.maxGuardrailRegression) {
    return learningDecisionSchema.parse({
      decision: "reject",
      relativeLift,
      reasons: ["Candidate breached a configured business guardrail."],
    });
  }

  const missingEvidence: string[] = [];
  if (evaluation.evidenceCount < policy.minEvidence) {
    missingEvidence.push(
      `Need ${policy.minEvidence - evaluation.evidenceCount} more observations.`,
    );
  }
  if (evaluation.uniqueEntities < policy.minUniqueEntities) {
    missingEvidence.push(
      `Need ${policy.minUniqueEntities - evaluation.uniqueEntities} more unique entities.`,
    );
  }
  if (evaluation.confidence < policy.minConfidence) {
    missingEvidence.push("Confidence is below the promotion threshold.");
  }

  if (missingEvidence.length > 0) {
    return learningDecisionSchema.parse({
      decision: "continue_experiment",
      relativeLift,
      reasons: missingEvidence,
    });
  }

  if (relativeLift < policy.minRelativeLift) {
    return learningDecisionSchema.parse({
      decision: "reject",
      relativeLift,
      reasons: ["Measured lift is below the promotion threshold."],
    });
  }

  if (
    policy.humanApprovalFor.includes(evaluation.risk) &&
    !evaluation.humanApproved
  ) {
    return learningDecisionSchema.parse({
      decision: "requires_approval",
      relativeLift,
      reasons: [
        "The change passed evidence gates but its risk requires approval.",
      ],
    });
  }

  return learningDecisionSchema.parse({
    decision: "promote",
    relativeLift,
    reasons: [
      "Candidate passed evidence, lift, confidence, and guardrail gates.",
    ],
  });
};

export const runtimeHealthStateSchema = z.enum([
  "healthy",
  "degraded",
  "recovering",
  "quarantined",
]);
export type RuntimeHealthState = z.infer<typeof runtimeHealthStateSchema>;

export const healingPolicySchema = z.object({
  maxErrorRate: z.number().min(0).max(1).default(0.05),
  maxConsecutiveFailures: z.number().int().positive().default(3),
  maxP95LatencyMs: z.number().positive().default(10_000),
  maxStalenessSeconds: z.number().int().positive().default(900),
  maxRecoveryAttempts: z.number().int().positive().default(3),
  baseBackoffSeconds: z.number().int().positive().default(30),
});
export type HealingPolicy = z.infer<typeof healingPolicySchema>;

export const runtimeHealthObservationSchema = z.object({
  componentId: z.string().min(1),
  currentState: runtimeHealthStateSchema,
  errorRate: z.number().min(0).max(1),
  consecutiveFailures: z.number().int().nonnegative(),
  p95LatencyMs: z.number().nonnegative(),
  stalenessSeconds: z.number().int().nonnegative(),
  dependencyAvailable: z.boolean(),
  fallbackAvailable: z.boolean(),
  lastKnownGoodAvailable: z.boolean(),
  recoveryAttempts: z.number().int().nonnegative(),
  guardrailBreached: z.boolean().default(false),
});

export type RuntimeHealthObservation = z.infer<
  typeof runtimeHealthObservationSchema
>;

export const healingDecisionSchema = z.object({
  nextState: runtimeHealthStateSchema,
  action: z.enum([
    "none",
    "resume",
    "retry_with_backoff",
    "use_fallback",
    "rollback",
    "quarantine_and_escalate",
  ]),
  allowExternalActions: z.boolean(),
  retryAfterSeconds: z.number().int().positive().nullable(),
  reasons: z.array(z.string().min(1)).min(1),
});

export type HealingDecision = z.infer<typeof healingDecisionSchema>;

/** Stateless health-state transition used by agents, workflows and connectors. */
export const decideHealingAction = (
  input: RuntimeHealthObservation,
  rawPolicy: Partial<HealingPolicy> = {},
): HealingDecision => {
  const health = runtimeHealthObservationSchema.parse(input);
  const policy = healingPolicySchema.parse(rawPolicy);
  const unhealthyReasons: string[] = [];

  if (!health.dependencyAvailable)
    unhealthyReasons.push("Dependency is unavailable.");
  if (health.errorRate > policy.maxErrorRate)
    unhealthyReasons.push("Error rate exceeds policy.");
  if (health.consecutiveFailures >= policy.maxConsecutiveFailures)
    unhealthyReasons.push("Consecutive failure limit reached.");
  if (health.p95LatencyMs > policy.maxP95LatencyMs)
    unhealthyReasons.push("Latency exceeds policy.");
  if (health.stalenessSeconds > policy.maxStalenessSeconds)
    unhealthyReasons.push("Component data is stale.");

  if (health.guardrailBreached) {
    return healingDecisionSchema.parse({
      nextState: "quarantined",
      action: health.lastKnownGoodAvailable
        ? "rollback"
        : "quarantine_and_escalate",
      allowExternalActions: false,
      retryAfterSeconds: null,
      reasons: ["A business or safety guardrail was breached."],
    });
  }

  if (unhealthyReasons.length === 0) {
    return healingDecisionSchema.parse({
      nextState: "healthy",
      action: health.currentState === "healthy" ? "none" : "resume",
      allowExternalActions: true,
      retryAfterSeconds: null,
      reasons: [
        health.currentState === "healthy"
          ? "Component is within all health thresholds."
          : "Recovery checks passed; normal execution can resume.",
      ],
    });
  }

  if (health.recoveryAttempts >= policy.maxRecoveryAttempts) {
    return healingDecisionSchema.parse({
      nextState: "quarantined",
      action: health.lastKnownGoodAvailable
        ? "rollback"
        : "quarantine_and_escalate",
      allowExternalActions: false,
      retryAfterSeconds: null,
      reasons: [
        "Automated recovery attempts were exhausted.",
        ...unhealthyReasons,
      ],
    });
  }

  if (health.fallbackAvailable) {
    return healingDecisionSchema.parse({
      nextState: "degraded",
      action: "use_fallback",
      allowExternalActions: true,
      retryAfterSeconds: policy.baseBackoffSeconds,
      reasons: unhealthyReasons,
    });
  }

  return healingDecisionSchema.parse({
    nextState: "recovering",
    action: "retry_with_backoff",
    allowExternalActions: false,
    retryAfterSeconds:
      policy.baseBackoffSeconds * 2 ** Math.min(health.recoveryAttempts, 8),
    reasons: unhealthyReasons,
  });
};

export const adaptiveGtmSettingsSchema = z.object({
  productProfile: gtmProductProfileSchema,
  learningPolicy: adaptiveLearningPolicySchema.default({}),
  healingPolicy: healingPolicySchema.default({}),
});

export type AdaptiveGtmSettings = z.infer<typeof adaptiveGtmSettingsSchema>;
