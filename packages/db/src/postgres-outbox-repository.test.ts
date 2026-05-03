import { describe, expect, it } from "vitest";
import {
  approvalFeedback,
  eventOutbox,
  motionScores,
  motionStack,
  workflowRuns,
} from "./schema.js";

// These tests verify the Drizzle schema contracts rather than the internal SQL
// of the Postgres repository. Integration tests against a real Postgres instance
// should be added to a separate test suite (e.g. packages/db/src/__integration__/).

describe("Drizzle schema: event_outbox", () => {
  it("has the required columns", () => {
    const columns = Object.keys(eventOutbox);
    expect(columns).toContain("id");
    expect(columns).toContain("tenantId");
    expect(columns).toContain("eventType");
    expect(columns).toContain("idempotencyKey");
    expect(columns).toContain("payload");
    expect(columns).toContain("createdAt");
    expect(columns).toContain("consumedAt");
  });

  it("id column is bigserial (auto-increment)", () => {
    expect(eventOutbox.id.dataType).toBe("bigint");
  });

  it("tenantId column is uuid", () => {
    // Drizzle uuid columns expose dataType:"string" + columnType:"PgUUID"
    expect(eventOutbox.tenantId.columnType).toBe("PgUUID");
    expect(eventOutbox.tenantId.notNull).toBe(true);
  });

  it("idempotencyKey column is not null text", () => {
    expect(eventOutbox.idempotencyKey.dataType).toBe("string");
    expect(eventOutbox.idempotencyKey.notNull).toBe(true);
  });

  it("consumedAt is nullable (marks unconsumed vs consumed events)", () => {
    expect(eventOutbox.consumedAt.notNull).toBe(false);
  });
});

describe("Drizzle schema: motion_scores", () => {
  it("has tenant_id as uuid", () => {
    expect(motionScores.tenantId.columnType).toBe("PgUUID");
    expect(motionScores.tenantId.notNull).toBe(true);
  });

  it("scores column is jsonb", () => {
    expect(motionScores.scores.dataType).toBe("json");
  });
});

describe("Drizzle schema: approval_feedback", () => {
  it("learnOptIn has a boolean default of true", () => {
    expect(approvalFeedback.learnOptIn.dataType).toBe("boolean");
    expect(approvalFeedback.learnOptIn.default).toBe(true);
  });
});

describe("Drizzle schema: workflow_runs", () => {
  it("has the required state-machine columns", () => {
    const columns = Object.keys(workflowRuns);
    expect(columns).toContain("state");
    expect(columns).toContain("failureCode");
    expect(columns).toContain("updatedAt");
  });

  it("state defaults to requested", () => {
    expect(workflowRuns.state.default).toBe("requested");
  });

  it("failureCode is nullable", () => {
    expect(workflowRuns.failureCode.notNull).toBe(false);
  });

  it("workflowId is a non-null text column", () => {
    expect(workflowRuns.workflowId.dataType).toBe("string");
    expect(workflowRuns.workflowId.notNull).toBe(true);
  });
});

describe("Drizzle schema: motion_stack", () => {
  it("has version column for optimistic concurrency", () => {
    expect(Object.keys(motionStack)).toContain("version");
  });
});
