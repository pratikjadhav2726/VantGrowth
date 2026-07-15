import { describe, expect, it } from "vitest";
import {
  decideHealingAction,
  evaluateLearningProposal,
  gtmProductProfileSchema,
} from "./adaptive-gtm-harness.js";

describe("gtmProductProfileSchema", () => {
  it("accepts a product-independent GTM context", () => {
    const profile = gtmProductProfileSchema.parse({
      schemaVersion: "gtm_product_profile.v1",
      tenantId: "00000000-0000-4000-8000-000000000001",
      product: {
        name: "Example",
        description: "A product with enough detail to ground every GTM agent.",
        category: "Revenue software",
        businessModel: "b2b_saas",
        salesMotion: "hybrid",
        valuePropositions: ["Reduce time to qualified pipeline"],
      },
      audiences: [
        {
          id: "revops",
          name: "Revenue operations",
          pains: ["Fragmented campaign data"],
          desiredOutcomes: ["Reliable attribution"],
        },
      ],
      funnel: {
        awarenessEvent: "qualified_visit",
        activationEvent: "workspace_connected",
        conversionEvent: "subscription_started",
        retentionEvent: "weekly_active_workspace",
        salesCycleDays: 30,
      },
      goals: [
        {
          metric: "qualified_pipeline",
          direction: "increase",
          target: 100_000,
          horizonDays: 90,
        },
      ],
      constraints: {
        monthlyBudget: 10_000,
        currencies: ["USD"],
        prohibitedClaims: [],
        prohibitedChannels: [],
        regulatedIndustry: false,
      },
    });

    expect(profile.product.businessModel).toBe("b2b_saas");
    expect(profile.product.proofPoints).toEqual([]);
  });
});

describe("evaluateLearningProposal", () => {
  const candidate = {
    proposalId: "proposal-1",
    risk: "low" as const,
    evidenceCount: 40,
    uniqueEntities: 25,
    confidence: 0.9,
    metricDirection: "increase" as const,
    baselineMetric: 0.1,
    candidateMetric: 0.12,
    worstGuardrailRegression: 0,
    humanApproved: false,
  };

  it("promotes a measured, low-risk improvement", () => {
    expect(evaluateLearningProposal(candidate).decision).toBe("promote");
  });

  it("keeps gathering evidence instead of learning from one event", () => {
    const result = evaluateLearningProposal({
      ...candidate,
      evidenceCount: 1,
      uniqueEntities: 1,
    });
    expect(result.decision).toBe("continue_experiment");
    expect(result.reasons).toHaveLength(2);
  });

  it("rejects candidates that hurt a guardrail", () => {
    expect(
      evaluateLearningProposal({
        ...candidate,
        worstGuardrailRegression: 0.08,
      }).decision,
    ).toBe("reject");
  });

  it("requires approval for high-risk promotions", () => {
    expect(
      evaluateLearningProposal({ ...candidate, risk: "high" }).decision,
    ).toBe("requires_approval");
  });

  it("supports metrics where lower is better", () => {
    expect(
      evaluateLearningProposal({
        ...candidate,
        metricDirection: "decrease",
        baselineMetric: 100,
        candidateMetric: 80,
      }).decision,
    ).toBe("promote");
  });
});

describe("decideHealingAction", () => {
  const healthy = {
    componentId: "n8n-dispatch",
    currentState: "healthy" as const,
    errorRate: 0,
    consecutiveFailures: 0,
    p95LatencyMs: 500,
    stalenessSeconds: 5,
    dependencyAvailable: true,
    fallbackAvailable: false,
    lastKnownGoodAvailable: true,
    recoveryAttempts: 0,
    guardrailBreached: false,
  };

  it("continues normal execution while healthy", () => {
    const result = decideHealingAction(healthy);
    expect(result.nextState).toBe("healthy");
    expect(result.allowExternalActions).toBe(true);
  });

  it("uses a fallback in degraded mode", () => {
    const result = decideHealingAction({
      ...healthy,
      dependencyAvailable: false,
      fallbackAvailable: true,
    });
    expect(result.action).toBe("use_fallback");
    expect(result.nextState).toBe("degraded");
  });

  it("rolls back and stops actions after a guardrail breach", () => {
    const result = decideHealingAction({ ...healthy, guardrailBreached: true });
    expect(result.action).toBe("rollback");
    expect(result.nextState).toBe("quarantined");
    expect(result.allowExternalActions).toBe(false);
  });

  it("quarantines after recovery is exhausted", () => {
    const result = decideHealingAction({
      ...healthy,
      errorRate: 0.5,
      recoveryAttempts: 3,
      lastKnownGoodAvailable: false,
    });
    expect(result.action).toBe("quarantine_and_escalate");
    expect(result.nextState).toBe("quarantined");
  });
});
