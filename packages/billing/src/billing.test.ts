import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HttpLagoBillingClient,
  PLAN_CODE_APPROVED_ACTION,
  PLAN_CODE_MOTION_ACTIVE,
  StubBillingClient,
} from "./lago-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeCustomerResponse = (
  overrides: Partial<{
    lago_id: string;
    external_id: string;
    name: string;
  }> = {},
) => ({
  customer: {
    lago_id: "lago-cust-001",
    external_id: "tenant-abc123",
    name: "Acme Corp",
    email: "billing@acme.com",
    currency: "USD",
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  },
});

const makeSubscriptionResponse = (
  overrides: Partial<{ lago_id: string; plan_code: string }> = {},
) => ({
  subscription: {
    lago_id: "lago-sub-001",
    external_id: "sub-tenant-abc123-motion",
    external_customer_id: "tenant-abc123",
    plan_code: PLAN_CODE_MOTION_ACTIVE,
    status: "active",
    started_at: "2026-01-01T00:00:00Z",
    ...overrides,
  },
});

const makeClient = () =>
  new HttpLagoBillingClient({
    baseUrl: "http://localhost:3000",
    apiKey: "test-lago-key",
  });

// ---------------------------------------------------------------------------
// HttpLagoBillingClient
// ---------------------------------------------------------------------------

describe("HttpLagoBillingClient", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("createCustomer", () => {
    it("creates a customer on 201", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 201,
        json: async () => makeCustomerResponse(),
      });
      vi.stubGlobal("fetch", mockFetch);

      const customer = await makeClient().createCustomer({
        externalId: "tenant-abc123",
        name: "Acme Corp",
        email: "billing@acme.com",
      });

      expect(customer.lagoId).toBe("lago-cust-001");
      expect(customer.externalId).toBe("tenant-abc123");
      expect(customer.name).toBe("Acme Corp");

      const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/api/v1/customers");
      const body = JSON.parse(opts.body as string);
      expect(body.customer.external_id).toBe("tenant-abc123");
    });

    it("upserts on 200 (existing customer)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          status: 200,
          json: async () => makeCustomerResponse(),
        }),
      );

      const customer = await makeClient().createCustomer({
        externalId: "tenant-abc123",
        name: "Acme",
      });
      expect(customer.lagoId).toBe("lago-cust-001");
    });

    it("throws on non-200/201", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          status: 422,
          json: async () => ({
            status: 422,
            error: "Unprocessable Entity",
            message: "Validation failed",
          }),
        }),
      );

      await expect(
        makeClient().createCustomer({ externalId: "bad", name: "Bad" }),
      ).rejects.toThrow("422");
    });
  });

  describe("assignPlan", () => {
    it("assigns motion_active plan", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          status: 200,
          json: async () => makeSubscriptionResponse(),
        }),
      );

      const sub = await makeClient().assignPlan({
        customerExternalId: "tenant-abc123",
        planCode: PLAN_CODE_MOTION_ACTIVE,
        subscriptionExternalId: "sub-tenant-abc123-motion",
      });

      expect(sub.lagoId).toBe("lago-sub-001");
      expect(sub.planCode).toBe(PLAN_CODE_MOTION_ACTIVE);
      expect(sub.status).toBe("active");
    });

    it("assigns approved_action plan", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          status: 201,
          json: async () =>
            makeSubscriptionResponse({ plan_code: PLAN_CODE_APPROVED_ACTION }),
        }),
      );

      const sub = await makeClient().assignPlan({
        customerExternalId: "tenant-abc123",
        planCode: PLAN_CODE_APPROVED_ACTION,
        subscriptionExternalId: "sub-tenant-abc123-action",
      });

      expect(sub.planCode).toBe(PLAN_CODE_APPROVED_ACTION);
    });

    it("sends billing_time: calendar in request body", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 200,
        json: async () => makeSubscriptionResponse(),
      });
      vi.stubGlobal("fetch", mockFetch);

      await makeClient().assignPlan({
        customerExternalId: "tenant-abc123",
        planCode: PLAN_CODE_MOTION_ACTIVE,
        subscriptionExternalId: "sub-xyz",
      });

      const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string);
      expect(body.subscription.billing_time).toBe("calendar");
    });
  });

  describe("recordEvent", () => {
    it("posts event and does not throw on success", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ status: 200, json: async () => ({}) }),
      );
      await expect(
        makeClient().recordEvent({
          transactionId: "txn-001",
          customerExternalId: "tenant-abc123",
          code: "motion_active",
          properties: { motion_count: 5 },
        }),
      ).resolves.toBeUndefined();
    });

    it("does not throw on non-200 (fire-and-forget)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ status: 503, json: async () => ({}) }),
      );
      await expect(
        makeClient().recordEvent({
          transactionId: "txn-002",
          customerExternalId: "tenant-abc123",
          code: "motion_active",
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe("deleteCustomer", () => {
    it("succeeds on 200", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ status: 200, json: async () => ({}) }),
      );
      await expect(
        makeClient().deleteCustomer("tenant-abc123"),
      ).resolves.toBeUndefined();
    });

    it("silently succeeds on 404", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ status: 404, json: async () => ({}) }),
      );
      await expect(
        makeClient().deleteCustomer("nonexistent"),
      ).resolves.toBeUndefined();
    });

    it("calls correct URL", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue({ status: 200, json: async () => ({}) });
      vi.stubGlobal("fetch", mockFetch);

      await makeClient().deleteCustomer("tenant-xyz");
      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toContain("/api/v1/customers/tenant-xyz");
    });
  });

  describe("fromEnv()", () => {
    it("throws when LAGO_API_URL is missing", () => {
      expect(() =>
        HttpLagoBillingClient.fromEnv({ LAGO_API_KEY: "key" }),
      ).toThrow("LAGO_API_URL");
    });

    it("throws when LAGO_API_KEY is missing", () => {
      expect(() =>
        HttpLagoBillingClient.fromEnv({
          LAGO_API_URL: "http://localhost:3000",
        }),
      ).toThrow("LAGO_API_KEY");
    });

    it("constructs from GROWTHOS_ prefixed env vars", () => {
      const client = HttpLagoBillingClient.fromEnv({
        GROWTHOS_LAGO_API_URL: "http://lago.local:3000",
        GROWTHOS_LAGO_API_KEY: "growthos-lago-key",
      });
      expect(client).toBeInstanceOf(HttpLagoBillingClient);
    });
  });
});

// ---------------------------------------------------------------------------
// Plan code constants
// ---------------------------------------------------------------------------

describe("plan codes", () => {
  it("exports expected plan code strings", () => {
    expect(PLAN_CODE_MOTION_ACTIVE).toBe("motion_active");
    expect(PLAN_CODE_APPROVED_ACTION).toBe("approved_action");
  });
});

// ---------------------------------------------------------------------------
// StubBillingClient
// ---------------------------------------------------------------------------

describe("StubBillingClient", () => {
  it("creates a customer", async () => {
    const stub = new StubBillingClient();
    const customer = await stub.createCustomer({
      externalId: "tenant-001",
      name: "Test Corp",
    });

    expect(customer.lagoId).toContain("tenant-001");
    expect(customer.externalId).toBe("tenant-001");
    expect(stub.createCustomerCalls).toHaveLength(1);
  });

  it("assigns a plan", async () => {
    const stub = new StubBillingClient();
    const sub = await stub.assignPlan({
      customerExternalId: "tenant-001",
      planCode: PLAN_CODE_MOTION_ACTIVE,
      subscriptionExternalId: "sub-001",
    });

    expect(sub.planCode).toBe(PLAN_CODE_MOTION_ACTIVE);
    expect(sub.status).toBe("active");
    expect(stub.assignPlanCalls).toHaveLength(1);
  });

  it("records events", async () => {
    const stub = new StubBillingClient();
    await stub.recordEvent({
      transactionId: "txn-001",
      customerExternalId: "tenant-001",
      code: "motion_active",
    });
    expect(stub.recordEventCalls).toHaveLength(1);
  });

  it("deletes a customer", async () => {
    const stub = new StubBillingClient();
    await stub.deleteCustomer("tenant-001");
    expect(stub.deleteCustomerCalls).toContain("tenant-001");
  });
});
