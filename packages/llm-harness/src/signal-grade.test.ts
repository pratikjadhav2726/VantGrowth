import { describe, expect, it } from "vitest";
import { StubLlmCallRunner } from "./llm-call-runner.js";
import { gradeSignalPayload } from "./signal-grade.js";

describe("gradeSignalPayload", () => {
  const VALID = JSON.stringify({
    relevance: 0.71,
    urgency: "medium",
    topic_category: "plg",
    action_recommendations: ["Double down on trials"],
  });

  it("returns SignalGrade for valid LLM JSON", async () => {
    const runner = new StubLlmCallRunner({ "signal.grade": VALID });
    const grade = await gradeSignalPayload(
      {
        tenantId: "00000000-0000-4000-8000-000000000001",
        signalType: "product",
        source: "intercom",
        payload: { text: "User asked about enterprise" },
      },
      runner,
    );
    expect(grade).not.toBeNull();
    expect(grade?.relevance).toBe(0.71);
    expect(grade?.topicCategory).toBe("plg");
  });

  it("returns null when response has no JSON object", async () => {
    const runner = new StubLlmCallRunner({ "signal.grade": "no json here" });
    const grade = await gradeSignalPayload(
      {
        tenantId: "00000000-0000-4000-8000-000000000001",
        signalType: "market",
        source: "x",
        payload: {},
      },
      runner,
    );
    expect(grade).toBeNull();
  });
});
