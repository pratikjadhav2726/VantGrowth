import { describe, expect, it } from "vitest";
import {
  callbackTypeToState,
  isCallbackLegalFromState,
  isTerminalState,
  validateWorkflowTransition,
  workflowRunStateSchema,
} from "./workflow-state.js";

describe("workflowRunStateSchema", () => {
  it("accepts all valid states", () => {
    const states = ["requested", "in_progress", "completed", "failed"];
    for (const s of states) {
      expect(() => workflowRunStateSchema.parse(s)).not.toThrow();
    }
  });

  it("rejects unknown states", () => {
    expect(() => workflowRunStateSchema.parse("unknown")).toThrow();
    expect(() => workflowRunStateSchema.parse("pending")).toThrow();
  });
});

describe("isTerminalState", () => {
  it("marks completed as terminal", () => {
    expect(isTerminalState("completed")).toBe(true);
  });

  it("marks failed as terminal", () => {
    expect(isTerminalState("failed")).toBe(true);
  });

  it("marks requested as non-terminal", () => {
    expect(isTerminalState("requested")).toBe(false);
  });

  it("marks in_progress as non-terminal", () => {
    expect(isTerminalState("in_progress")).toBe(false);
  });
});

describe("validateWorkflowTransition", () => {
  it("allows requested → in_progress", () => {
    const result = validateWorkflowTransition("requested", "in_progress");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.toState).toBe("in_progress");
  });

  it("allows requested → completed", () => {
    const result = validateWorkflowTransition("requested", "completed");
    expect(result.ok).toBe(true);
  });

  it("allows requested → failed", () => {
    const result = validateWorkflowTransition("requested", "failed");
    expect(result.ok).toBe(true);
  });

  it("allows in_progress → in_progress (repeated progress updates)", () => {
    const result = validateWorkflowTransition("in_progress", "in_progress");
    expect(result.ok).toBe(true);
  });

  it("allows in_progress → completed", () => {
    const result = validateWorkflowTransition("in_progress", "completed");
    expect(result.ok).toBe(true);
  });

  it("allows in_progress → failed", () => {
    const result = validateWorkflowTransition("in_progress", "failed");
    expect(result.ok).toBe(true);
  });

  it("rejects completed → in_progress (terminal state)", () => {
    const result = validateWorkflowTransition("completed", "in_progress");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fromState).toBe("completed");
      expect(result.toState).toBe("in_progress");
      expect(result.reason).toContain("completed");
    }
  });

  it("rejects completed → failed (terminal state)", () => {
    const result = validateWorkflowTransition("completed", "failed");
    expect(result.ok).toBe(false);
  });

  it("rejects failed → completed (terminal state)", () => {
    const result = validateWorkflowTransition("failed", "completed");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fromState).toBe("failed");
  });

  it("rejects failed → in_progress (terminal state)", () => {
    const result = validateWorkflowTransition("failed", "in_progress");
    expect(result.ok).toBe(false);
  });

  it("rejects completed → requested (terminal state)", () => {
    const result = validateWorkflowTransition("completed", "requested");
    expect(result.ok).toBe(false);
  });
});

describe("callbackTypeToState", () => {
  it("maps progress to in_progress", () => {
    expect(callbackTypeToState("progress")).toBe("in_progress");
  });

  it("maps completed to completed", () => {
    expect(callbackTypeToState("completed")).toBe("completed");
  });

  it("maps failed to failed", () => {
    expect(callbackTypeToState("failed")).toBe("failed");
  });
});

describe("isCallbackLegalFromState", () => {
  it("allows progress callback from requested", () => {
    expect(isCallbackLegalFromState("requested", "progress")).toBe(true);
  });

  it("allows progress callback from in_progress", () => {
    expect(isCallbackLegalFromState("in_progress", "progress")).toBe(true);
  });

  it("allows completed callback from in_progress", () => {
    expect(isCallbackLegalFromState("in_progress", "completed")).toBe(true);
  });

  it("allows failed callback from in_progress", () => {
    expect(isCallbackLegalFromState("in_progress", "failed")).toBe(true);
  });

  it("blocks any callback from completed (terminal)", () => {
    expect(isCallbackLegalFromState("completed", "progress")).toBe(false);
    expect(isCallbackLegalFromState("completed", "completed")).toBe(false);
    expect(isCallbackLegalFromState("completed", "failed")).toBe(false);
  });

  it("blocks any callback from failed (terminal)", () => {
    expect(isCallbackLegalFromState("failed", "progress")).toBe(false);
    expect(isCallbackLegalFromState("failed", "completed")).toBe(false);
    expect(isCallbackLegalFromState("failed", "failed")).toBe(false);
  });
});
