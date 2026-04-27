import { describe, expect, it } from "vitest";
import { createTenantSettingsSql, tenantScopedSubject } from "./tenant-context.js";

const tenantId = "00000000-0000-4000-8000-000000000001";

describe("tenant context helpers", () => {
  it("creates tenant-prefixed subjects", () => {
    expect(tenantScopedSubject(tenantId, "signal.routed.v1")).toBe(`t.${tenantId}.signal.routed.v1`);
  });

  it("creates SQL for setting request-local tenant context", () => {
    const statement = createTenantSettingsSql({
      tenantId,
      actorId: "actor-1",
      actorKind: "user"
    });

    expect(statement.sql).toContain("set_config('app.tenant_id'");
    expect(statement.params).toEqual([tenantId, "actor-1", "user"]);
  });
});
