import { describe, expect, it } from "vitest";
import {
  comparePromptPriority,
  resolvePromptInstructions,
} from "./prompt-priority.js";

describe("comparePromptPriority", () => {
  it("orders higher-priority sources above lower-priority sources", () => {
    expect(comparePromptPriority("system", "user")).toBeGreaterThan(0);
    expect(comparePromptPriority("history", "developer")).toBeLessThan(0);
    expect(comparePromptPriority("repo", "repo")).toBe(0);
  });
});

describe("resolvePromptInstructions", () => {
  it("marks lower-priority conflicting instructions as overridden", () => {
    const resolved = resolvePromptInstructions([
      { source: "user", key: "external_write", value: "allowed" },
      { source: "system", key: "external_write", value: "approval_required" },
      { source: "repo", key: "tone", value: "direct" },
    ]);

    expect(resolved[0]?.overriddenBy?.source).toBe("system");
    expect(resolved[1]?.overriddenBy).toBeUndefined();
    expect(resolved[2]?.overriddenBy).toBeUndefined();
  });
});
