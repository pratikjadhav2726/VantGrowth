import { describe, expect, it } from "vitest";
import { parseOutboxNotificationTenantId } from "./outbox-notifier.js";

describe("parseOutboxNotificationTenantId", () => {
  it("returns tenant id from valid JSON payload", () => {
    const tenantId = "11111111-1111-4111-8111-111111111111";
    expect(
      parseOutboxNotificationTenantId(
        JSON.stringify({ tenantId, eventId: "1" }),
      ),
    ).toBe(tenantId);
  });

  it("returns null for invalid or missing tenant id payload", () => {
    expect(parseOutboxNotificationTenantId(null)).toBeNull();
    expect(parseOutboxNotificationTenantId("invalid")).toBeNull();
    expect(
      parseOutboxNotificationTenantId(JSON.stringify({ eventId: "1" })),
    ).toBeNull();
  });
});
