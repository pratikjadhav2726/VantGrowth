import { describe, expect, it } from "vitest";
import { parseSmokeEnv } from "./smoke-env.js";

describe("parseSmokeEnv", () => {
  it("parses minimal Postgres + NATS smoke env", () => {
    const env = parseSmokeEnv({
      DATABASE_URL: "postgres://user:pass@localhost:5432/growthos",
    });
    expect(env.DATABASE_URL).toContain("postgres://");
    expect(env.NATS_SERVERS).toBe("nats://localhost:4222");
  });

  it("rejects Restate base URL without workflow id", () => {
    expect(() =>
      parseSmokeEnv({
        DATABASE_URL: "postgres://user:pass@localhost:5432/growthos",
        RESTATE_BASE_URL: "http://localhost:8080",
      }),
    ).toThrow(/both RESTATE_BASE_URL/);
  });

  it("rejects workflow id without Restate base URL", () => {
    expect(() =>
      parseSmokeEnv({
        DATABASE_URL: "postgres://user:pass@localhost:5432/growthos",
        GROWTHOS_SMOKE_WORKFLOW_ID: "wf-smoke-1",
      }),
    ).toThrow(/both RESTATE_BASE_URL/);
  });

  it("accepts paired Restate + workflow env", () => {
    const env = parseSmokeEnv({
      DATABASE_URL: "postgres://user:pass@localhost:5432/growthos",
      RESTATE_BASE_URL: "http://localhost:8080",
      GROWTHOS_SMOKE_WORKFLOW_ID: "wf-smoke-1",
      RESTATE_TIMEOUT_MS: "3000",
    });
    expect(env.RESTATE_BASE_URL).toBe("http://localhost:8080");
    expect(env.GROWTHOS_SMOKE_WORKFLOW_ID).toBe("wf-smoke-1");
    expect(env.RESTATE_TIMEOUT_MS).toBe(3000);
  });
});
