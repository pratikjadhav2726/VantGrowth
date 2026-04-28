import { describe, expect, it } from "vitest";
import { InMemoryPlaybookVersionsRepository } from "./playbook-versions-repository.js";

const TENANT_A = "00000000-0000-4000-8000-000000000010";
const TENANT_B = "00000000-0000-4000-8000-000000000011";

const baseParams = {
  playbookType: "content_brief" as const,
  name: "Content Brief v1",
  content: { rubric: ["clarity", "evidence", "cta"] },
  createdBy: "founder",
};

describe("InMemoryPlaybookVersionsRepository", () => {
  it("getActive returns null when no versions exist", async () => {
    const repo = new InMemoryPlaybookVersionsRepository();
    const result = await repo.getActive(TENANT_A, "content_brief");
    expect(result).toBeNull();
  });

  it("create auto-assigns version 1 for the first record", async () => {
    const repo = new InMemoryPlaybookVersionsRepository();
    const record = await repo.create(TENANT_A, baseParams);
    expect(record.version).toBe(1);
    expect(record.tenantId).toBe(TENANT_A);
    expect(record.playbookType).toBe("content_brief");
    expect(record.retiredAt).toBeNull();
  });

  it("create increments version independently per (tenant, type)", async () => {
    const repo = new InMemoryPlaybookVersionsRepository();
    const v1 = await repo.create(TENANT_A, baseParams);
    const v2 = await repo.create(TENANT_A, { ...baseParams, name: "v2" });
    const tenantBV1 = await repo.create(TENANT_B, baseParams);

    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(tenantBV1.version).toBe(1); // independent counter
  });

  it("getActive returns the highest-versioned non-retired record", async () => {
    const repo = new InMemoryPlaybookVersionsRepository();
    await repo.create(TENANT_A, baseParams);
    const v2 = await repo.create(TENANT_A, { ...baseParams, name: "v2" });

    const active = await repo.getActive(TENANT_A, "content_brief");
    expect(active?.id).toBe(v2.id);
    expect(active?.version).toBe(2);
  });

  it("retire soft-retires a record — getActive then returns the next best", async () => {
    const repo = new InMemoryPlaybookVersionsRepository();
    const v1 = await repo.create(TENANT_A, baseParams);
    const v2 = await repo.create(TENANT_A, { ...baseParams, name: "v2" });

    await repo.retire(TENANT_A, v2.id);

    const active = await repo.getActive(TENANT_A, "content_brief");
    expect(active?.id).toBe(v1.id); // falls back to v1
    const retired = (await repo.listAll(TENANT_A, "content_brief")).find(
      (r) => r.id === v2.id,
    );
    expect(retired?.retiredAt).not.toBeNull();
  });

  it("retire is idempotent when called twice", async () => {
    const repo = new InMemoryPlaybookVersionsRepository();
    const v1 = await repo.create(TENANT_A, baseParams);
    await repo.retire(TENANT_A, v1.id);
    await repo.retire(TENANT_A, v1.id); // second call — no throw
    expect(true).toBe(true);
  });

  it("retire is a no-op for an unknown id", async () => {
    const repo = new InMemoryPlaybookVersionsRepository();
    await repo.retire(TENANT_A, "unknown-id"); // no throw
    expect(true).toBe(true);
  });

  it("retire respects tenant scope", async () => {
    const repo = new InMemoryPlaybookVersionsRepository();
    const v1 = await repo.create(TENANT_A, baseParams);
    await repo.retire(TENANT_B, v1.id); // wrong tenant — no-op
    const record = (await repo.listAll(TENANT_A, "content_brief"))[0];
    expect(record?.retiredAt).toBeNull();
  });

  it("listAll returns all versions newest-first including retired", async () => {
    const repo = new InMemoryPlaybookVersionsRepository();
    const v1 = await repo.create(TENANT_A, baseParams);
    const v2 = await repo.create(TENANT_A, { ...baseParams, name: "v2" });
    await repo.retire(TENANT_A, v1.id);

    const all = await repo.listAll(TENANT_A, "content_brief");
    expect(all).toHaveLength(2);
    expect(all[0]?.id).toBe(v2.id); // newest first
    expect(all[1]?.retiredAt).not.toBeNull(); // v1 is retired
  });

  it("is isolated across playbook types", async () => {
    const repo = new InMemoryPlaybookVersionsRepository();
    await repo.create(TENANT_A, {
      ...baseParams,
      playbookType: "content_brief",
    });
    await repo.create(TENANT_A, { ...baseParams, playbookType: "intel_brief" });

    const contentBriefs = await repo.listAll(TENANT_A, "content_brief");
    const intelBriefs = await repo.listAll(TENANT_A, "intel_brief");
    expect(contentBriefs).toHaveLength(1);
    expect(intelBriefs).toHaveLength(1);
    expect(contentBriefs[0]?.version).toBe(1);
    expect(intelBriefs[0]?.version).toBe(1);
  });

  it("stores and retrieves content payload accurately", async () => {
    const repo = new InMemoryPlaybookVersionsRepository();
    const content = {
      rubric: [{ id: "r1", weight: 0.4, description: "Clarity" }],
    };
    const record = await repo.create(TENANT_A, { ...baseParams, content });
    expect(record.content).toEqual(content);
  });
});
