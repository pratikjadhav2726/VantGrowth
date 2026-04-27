import { describe, expect, it } from "vitest";
import { scoreMotions } from "./index.js";

describe("scoreMotions", () => {
  it("returns deterministic primary and secondary motion sets", () => {
    const result = scoreMotions({
      tenantId: "ten_1",
      productComplexity: 0.7,
      trialability: 0.6,
      acvBand: 0.5,
      salesCycleWeeks: 5,
      founderContentCapacity: 0.8,
      categorySearchDemand: 0.9,
      communityDensity: 0.7,
      telemetryReadiness: 0.6,
      budgetReadiness: 0.5,
    });

    expect(result.scorerVersion).toBe("motion_scorer.v1");
    expect(result.selectedPrimary).toHaveLength(2);
    expect(result.selectedSecondary).toHaveLength(2);
  });
});
