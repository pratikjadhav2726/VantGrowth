import { describe, expect, it } from "vitest";
import {
  renderHarnessCardMarkdown,
  summarizeHarnessCoverage,
} from "./harness-card.js";

describe("renderHarnessCardMarkdown", () => {
  it("renders component coverage, eval metrics, ablation, and known gaps", () => {
    const markdown = renderHarnessCardMarkdown({
      harnessName: "GrowthOS Content Strategist",
      owner: "growthos",
      generatedAt: new Date("2026-07-09T12:00:00.000Z"),
      modelPolicy: "default=gpt-4o-mini, critic=gpt-4o",
      promptPriorityPolicy: "system > tool > developer > repo > user > history",
      components: [
        {
          layer: "control",
          name: "approval gate",
          status: "implemented",
          version: "1.0.0",
          evidence: "apps/api/src/routes/approvals.ts",
        },
      ],
      goldenEval: {
        cases: [],
        totalCases: 3,
        totalAttempts: 9,
        passAt1: 0.89,
        passK: 0.7,
        passed: false,
      },
      ablation: {
        baseline: {
          cases: [],
          totalCases: 3,
          totalAttempts: 9,
          passAt1: 0.75,
          passK: 0.42,
          passed: false,
        },
        candidate: {
          cases: [],
          totalCases: 3,
          totalAttempts: 9,
          passAt1: 0.89,
          passK: 0.7,
          passed: false,
        },
        passAt1Delta: 0.14,
        passKDelta: 0.28,
        exceedsInfraNoise: true,
      },
      knownGaps: ["Sandbox egress policy not yet wired."],
    });

    expect(markdown).toContain("# GrowthOS Content Strategist Harness Card");
    expect(markdown).toContain("| control | approval gate | yes |");
    expect(markdown).toContain("pass@1: 89.0%");
    expect(markdown).toContain("Clears infra-noise threshold: yes");
    expect(markdown).toContain("Sandbox egress policy");
  });
});

describe("summarizeHarnessCoverage", () => {
  it("scores partial components as half coverage", () => {
    const summary = summarizeHarnessCoverage([
      { layer: "control", name: "loop", status: "implemented" },
      { layer: "control", name: "policy", status: "partial" },
      { layer: "agency", name: "tools", status: "missing" },
    ]);

    expect(summary.control).toEqual({
      implemented: 1,
      total: 2,
      score: 0.75,
    });
    expect(summary.agency.score).toBe(0);
  });
});
