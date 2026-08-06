import { describe, expect, it } from "vitest";
import { deterministicUuid } from "./stable-id.js";

describe("deterministicUuid", () => {
  it("is stable and emits an RFC-4122-shaped version-5 UUID", () => {
    expect(deterministicUuid("tenant:signal:42")).toBe(
      deterministicUuid("tenant:signal:42"),
    );
    expect(deterministicUuid("tenant:signal:42")).not.toBe(
      deterministicUuid("tenant:signal:43"),
    );
    expect(deterministicUuid("tenant:signal:42")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
