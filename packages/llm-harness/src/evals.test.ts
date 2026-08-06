import { describe, expect, it } from "vitest";
import {
  compareHarnessRuns,
  computePassK,
  contentIncludes,
  contentMatches,
  runGoldenEvalSuite,
  validJsonObject,
} from "./evals.js";
import { StubLlmCallRunner } from "./llm-call-runner.js";
import { definePrompt } from "./prompt-template.js";

const template = definePrompt<{ topic: string }>({
  id: "eval.test",
  version: "1.0.0",
  render: ({ topic }) => `Write about ${topic}`,
});

describe("computePassK", () => {
  it("computes probability all k attempts pass", () => {
    expect(computePassK(0.9, 3)).toBeCloseTo(0.729, 3);
  });

  it("rejects invalid inputs", () => {
    expect(() => computePassK(1.2, 2)).toThrow();
    expect(() => computePassK(0.8, 0)).toThrow();
  });
});

describe("runGoldenEvalSuite", () => {
  it("runs deterministic assertions over repeated attempts", async () => {
    const runner = new StubLlmCallRunner({
      "eval.test": ({ topic }) => `A useful ${topic} brief with CTA`,
    });

    const result = await runGoldenEvalSuite(runner, [
      {
        id: "case-1",
        description: "content brief includes required concepts",
        template,
        vars: { topic: "PLG" },
        attempts: 2,
        assertions: [
          contentIncludes("has-topic", "PLG"),
          contentMatches("has-cta", /CTA/),
        ],
      },
    ]);

    expect(result.totalCases).toBe(1);
    expect(result.totalAttempts).toBe(2);
    expect(result.passAt1).toBe(1);
    expect(result.passK).toBe(1);
    expect(result.passed).toBe(true);
  });

  it("captures assertion failures and lowers pass metrics", async () => {
    const runner = new StubLlmCallRunner({ "eval.test": "nope" });

    const result = await runGoldenEvalSuite(runner, [
      {
        id: "case-1",
        description: "missing expected content",
        template,
        vars: { topic: "PLG" },
        assertions: [contentIncludes("has-topic", "PLG")],
      },
    ]);

    expect(result.passAt1).toBe(0);
    expect(result.passK).toBe(0);
    expect(result.passed).toBe(false);
    expect(
      result.cases[0]?.attempts[0]?.assertionResults[0]?.details,
    ).toContain("Expected content");
  });

  it("supports JSON object assertions", async () => {
    const runner = new StubLlmCallRunner({
      "eval.test": '{"title":"PLG","score":0.9}',
    });

    const result = await runGoldenEvalSuite(runner, [
      {
        id: "json-case",
        description: "structured output parses",
        template,
        vars: { topic: "PLG" },
        assertions: [validJsonObject()],
      },
    ]);

    expect(result.passed).toBe(true);
  });
});

describe("compareHarnessRuns", () => {
  it("reports ablation deltas against an infra-noise threshold", () => {
    const baseline = {
      cases: [],
      totalCases: 1,
      totalAttempts: 10,
      passAt1: 0.7,
      passK: 0.49,
      passed: false,
    };
    const candidate = {
      ...baseline,
      passAt1: 0.76,
      passK: 0.58,
    };

    const comparison = compareHarnessRuns(baseline, candidate);
    expect(comparison.passAt1Delta).toBeCloseTo(0.06);
    expect(comparison.exceedsInfraNoise).toBe(true);
  });
});
