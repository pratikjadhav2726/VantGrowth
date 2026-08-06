import type { LlmCallResult, LlmCallRunner } from "./llm-call-runner.js";
import type { PromptTemplate } from "./prompt-template.js";

export interface GoldenEvalAssertion {
  id: string;
  description: string;
  evaluate(result: LlmCallResult): EvalAssertionResult;
}

export type EvalAssertionResult =
  | { passed: true; details?: string }
  | { passed: false; details: string };

export interface GoldenEvalCase<
  TVars extends Record<string, unknown> = Record<string, unknown>,
> {
  id: string;
  description: string;
  template: PromptTemplate<TVars>;
  vars: TVars;
  assertions: GoldenEvalAssertion[];
  attempts?: number;
}

export interface GoldenEvalAttemptResult {
  attempt: number;
  result: LlmCallResult;
  assertionResults: Array<{
    id: string;
    description: string;
    passed: boolean;
    details?: string;
  }>;
  passed: boolean;
}

export interface GoldenEvalCaseResult {
  id: string;
  description: string;
  attempts: GoldenEvalAttemptResult[];
  passAt1: number;
  passK: number;
  passedAllAttempts: boolean;
}

export interface GoldenEvalSuiteResult {
  cases: GoldenEvalCaseResult[];
  totalCases: number;
  totalAttempts: number;
  passAt1: number;
  passK: number;
  passed: boolean;
}

export interface RunGoldenEvalOptions {
  attemptsPerCase?: number;
}

export const computePassK = (passAt1: number, k: number): number => {
  if (!Number.isFinite(passAt1) || passAt1 < 0 || passAt1 > 1) {
    throw new Error("passAt1 must be a number in [0, 1]");
  }
  if (!Number.isInteger(k) || k < 1) {
    throw new Error("k must be a positive integer");
  }
  return passAt1 ** k;
};

export const runGoldenEvalSuite = async (
  runner: LlmCallRunner,
  cases: GoldenEvalCase[],
  options: RunGoldenEvalOptions = {},
): Promise<GoldenEvalSuiteResult> => {
  const results: GoldenEvalCaseResult[] = [];

  for (const testCase of cases) {
    const attempts = testCase.attempts ?? options.attemptsPerCase ?? 1;
    const attemptResults: GoldenEvalAttemptResult[] = [];

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const result = await runner.run(testCase.template, testCase.vars);
      const assertionResults = testCase.assertions.map((assertion) => {
        const assertionResult = assertion.evaluate(result);
        return {
          id: assertion.id,
          description: assertion.description,
          passed: assertionResult.passed,
          ...(assertionResult.details !== undefined
            ? { details: assertionResult.details }
            : {}),
        };
      });
      const passed = assertionResults.every((r) => r.passed);

      attemptResults.push({
        attempt,
        result,
        assertionResults,
        passed,
      });
    }

    const successfulAttempts = attemptResults.filter((r) => r.passed).length;
    const passAt1 = successfulAttempts / attempts;
    results.push({
      id: testCase.id,
      description: testCase.description,
      attempts: attemptResults,
      passAt1,
      passK: computePassK(passAt1, attempts),
      passedAllAttempts: successfulAttempts === attempts,
    });
  }

  const totalAttempts = results.reduce((sum, r) => sum + r.attempts.length, 0);
  const successfulAttempts = results.reduce(
    (sum, r) => sum + r.attempts.filter((a) => a.passed).length,
    0,
  );
  const passAt1 = totalAttempts === 0 ? 0 : successfulAttempts / totalAttempts;
  const maxAttempts = Math.max(1, ...results.map((r) => r.attempts.length));

  return {
    cases: results,
    totalCases: results.length,
    totalAttempts,
    passAt1,
    passK: computePassK(passAt1, maxAttempts),
    passed: results.every((r) => r.passedAllAttempts),
  };
};

export interface HarnessAblationComparison {
  baseline: GoldenEvalSuiteResult;
  candidate: GoldenEvalSuiteResult;
  passAt1Delta: number;
  passKDelta: number;
  exceedsInfraNoise: boolean;
}

export const compareHarnessRuns = (
  baseline: GoldenEvalSuiteResult,
  candidate: GoldenEvalSuiteResult,
  infraNoiseThreshold = 0.03,
): HarnessAblationComparison => {
  const passAt1Delta = candidate.passAt1 - baseline.passAt1;
  const passKDelta = candidate.passK - baseline.passK;
  return {
    baseline,
    candidate,
    passAt1Delta,
    passKDelta,
    exceedsInfraNoise: Math.abs(passAt1Delta) >= infraNoiseThreshold,
  };
};

export const contentIncludes = (
  id: string,
  expected: string,
): GoldenEvalAssertion => ({
  id,
  description: `content includes "${expected}"`,
  evaluate: (result) =>
    result.content.includes(expected)
      ? { passed: true }
      : {
          passed: false,
          details: `Expected content to include "${expected}".`,
        },
});

export const contentMatches = (
  id: string,
  pattern: RegExp,
): GoldenEvalAssertion => ({
  id,
  description: `content matches ${pattern.toString()}`,
  evaluate: (result) =>
    pattern.test(result.content)
      ? { passed: true }
      : {
          passed: false,
          details: `Expected content to match ${pattern.toString()}.`,
        },
});

export const validJsonObject = (id = "valid-json"): GoldenEvalAssertion => ({
  id,
  description: "content parses as a JSON object",
  evaluate: (result) => {
    try {
      const parsed = JSON.parse(result.content) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        return { passed: true };
      }
      return { passed: false, details: "Parsed JSON is not an object." };
    } catch (error) {
      return {
        passed: false,
        details:
          error instanceof Error ? error.message : "Content is not valid JSON.",
      };
    }
  },
});
