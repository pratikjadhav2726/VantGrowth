import { describe, expect, it } from "vitest";
import { InMemoryWorkflowRunRepository } from "./workflow-run-repository.js";

const tenantId = "00000000-0000-4000-8000-000000000001";
const workflowId = "wf-provision-1";
const dedupeKey = "dedup-1";

describe("InMemoryWorkflowRunRepository", () => {
  describe("upsertRequested", () => {
    it("creates a run in requested state", async () => {
      const repo = new InMemoryWorkflowRunRepository();
      const run = await repo.upsertRequested(tenantId, workflowId, dedupeKey);

      expect(run.tenantId).toBe(tenantId);
      expect(run.workflowId).toBe(workflowId);
      expect(run.dedupeKey).toBe(dedupeKey);
      expect(run.state).toBe("requested");
      expect(run.failureCode).toBeNull();
      expect(run.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it("is idempotent — returns same record on repeated calls", async () => {
      const repo = new InMemoryWorkflowRunRepository();
      const first = await repo.upsertRequested(tenantId, workflowId, dedupeKey);
      const second = await repo.upsertRequested(
        tenantId,
        workflowId,
        "different-dedupe",
      );

      expect(first.id).toBe(second.id);
      expect(second.dedupeKey).toBe(dedupeKey);
    });

    it("allows concurrent upserts for different workflows", async () => {
      const repo = new InMemoryWorkflowRunRepository();
      const a = await repo.upsertRequested(tenantId, "wf-a", "dk-a");
      const b = await repo.upsertRequested(tenantId, "wf-b", "dk-b");

      expect(a.id).not.toBe(b.id);
      expect(a.state).toBe("requested");
      expect(b.state).toBe("requested");
    });
  });

  describe("getByWorkflowId", () => {
    it("returns null for unknown workflow", async () => {
      const repo = new InMemoryWorkflowRunRepository();
      const run = await repo.getByWorkflowId(tenantId, "wf-unknown");
      expect(run).toBeNull();
    });

    it("returns the stored run after upsert", async () => {
      const repo = new InMemoryWorkflowRunRepository();
      await repo.upsertRequested(tenantId, workflowId, dedupeKey);
      const run = await repo.getByWorkflowId(tenantId, workflowId);

      expect(run).not.toBeNull();
      expect(run?.state).toBe("requested");
    });

    it("isolates runs across tenants", async () => {
      const repo = new InMemoryWorkflowRunRepository();
      const otherTenant = "00000000-0000-4000-8000-000000000002";
      await repo.upsertRequested(tenantId, workflowId, dedupeKey);

      const crossTenant = await repo.getByWorkflowId(otherTenant, workflowId);
      expect(crossTenant).toBeNull();
    });
  });

  describe("transitionState", () => {
    it("transitions requested → in_progress", async () => {
      const repo = new InMemoryWorkflowRunRepository();
      await repo.upsertRequested(tenantId, workflowId, dedupeKey);

      const updated = await repo.transitionState(
        tenantId,
        workflowId,
        "requested",
        "in_progress",
      );

      expect(updated).not.toBeNull();
      expect(updated?.state).toBe("in_progress");
    });

    it("transitions in_progress → completed", async () => {
      const repo = new InMemoryWorkflowRunRepository();
      await repo.upsertRequested(tenantId, workflowId, dedupeKey);
      await repo.transitionState(
        tenantId,
        workflowId,
        "requested",
        "in_progress",
      );

      const updated = await repo.transitionState(
        tenantId,
        workflowId,
        "in_progress",
        "completed",
      );

      expect(updated?.state).toBe("completed");
    });

    it("transitions in_progress → failed with failureCode", async () => {
      const repo = new InMemoryWorkflowRunRepository();
      await repo.upsertRequested(tenantId, workflowId, dedupeKey);
      await repo.transitionState(
        tenantId,
        workflowId,
        "requested",
        "in_progress",
      );

      const updated = await repo.transitionState(
        tenantId,
        workflowId,
        "in_progress",
        "failed",
        "PROVISIONING_TIMEOUT",
      );

      expect(updated?.state).toBe("failed");
      expect(updated?.failureCode).toBe("PROVISIONING_TIMEOUT");
    });

    it("returns null when fromState is stale (CAS guard)", async () => {
      const repo = new InMemoryWorkflowRunRepository();
      await repo.upsertRequested(tenantId, workflowId, dedupeKey);
      // State is "requested" but we attempt to transition from "in_progress"
      const result = await repo.transitionState(
        tenantId,
        workflowId,
        "in_progress",
        "completed",
      );

      expect(result).toBeNull();

      // Confirms the state was NOT mutated
      const unchanged = await repo.getByWorkflowId(tenantId, workflowId);
      expect(unchanged?.state).toBe("requested");
    });

    it("blocks transitions out of completed (terminal)", async () => {
      const repo = new InMemoryWorkflowRunRepository();
      await repo.upsertRequested(tenantId, workflowId, dedupeKey);
      await repo.transitionState(
        tenantId,
        workflowId,
        "requested",
        "completed",
      );

      const blocked = await repo.transitionState(
        tenantId,
        workflowId,
        "completed",
        "in_progress",
      );

      expect(blocked).toBeNull();
    });

    it("blocks transitions out of failed (terminal)", async () => {
      const repo = new InMemoryWorkflowRunRepository();
      await repo.upsertRequested(tenantId, workflowId, dedupeKey);
      await repo.transitionState(tenantId, workflowId, "requested", "failed");

      const blocked = await repo.transitionState(
        tenantId,
        workflowId,
        "failed",
        "completed",
      );

      expect(blocked).toBeNull();
    });

    it("returns null for unknown workflowId", async () => {
      const repo = new InMemoryWorkflowRunRepository();
      const result = await repo.transitionState(
        tenantId,
        "wf-unknown",
        "requested",
        "in_progress",
      );

      expect(result).toBeNull();
    });

    it("updatedAt advances on successful transition", async () => {
      const repo = new InMemoryWorkflowRunRepository();
      const original = await repo.upsertRequested(
        tenantId,
        workflowId,
        dedupeKey,
      );
      await new Promise((r) => setTimeout(r, 2));

      const updated = await repo.transitionState(
        tenantId,
        workflowId,
        "requested",
        "in_progress",
      );

      expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(
        original.updatedAt.getTime(),
      );
    });
  });
});
