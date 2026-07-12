import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HttpZitadelClient,
  StubZitadelClient,
  type ZitadelOrg,
} from "./zitadel-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeOrgResponse = (
  overrides: Partial<{ orgId: string; createdAt: string }> = {},
) => ({
  orgId: "zitadel-org-001",
  createdAt: "2026-01-01T00:00:00Z",
  ...overrides,
});

const makeGetOrgResponse = (
  overrides: Partial<{ id: string; name: string; state: string }> = {},
) => ({
  org: {
    id: "zitadel-org-001",
    name: "Acme Corp",
    primaryDomain: "acme.growthos.io",
    state: "ORG_STATE_ACTIVE",
    details: { creationDate: "2026-01-01T00:00:00Z" },
    ...overrides,
  },
});

const makeMachineResponse = (overrides: Partial<{ userId: string }> = {}) => ({
  userId: "zitadel-sa-001",
  createdAt: "2026-01-01T00:00:00Z",
  ...overrides,
});

const makeClient = () =>
  new HttpZitadelClient({
    baseUrl: "http://localhost:8080",
    token: "test-zitadel-token",
  });

// ---------------------------------------------------------------------------
// HttpZitadelClient
// ---------------------------------------------------------------------------

describe("HttpZitadelClient", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("createOrg", () => {
    it("creates an org and returns it", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 201,
        json: async () => makeOrgResponse(),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = makeClient();
      const org = await client.createOrg({ name: "Acme Corp" });

      expect(org.orgId).toBe("zitadel-org-001");
      expect(org.name).toBe("Acme Corp");
      expect(org.state).toBe("ORG_STATE_ACTIVE");

      const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/admin/v1/orgs");
      expect(JSON.parse(opts.body as string)).toMatchObject({
        name: "Acme Corp",
      });
    });

    it("returns existing org on 409 conflict", async () => {
      const searchResponse = {
        result: [
          {
            id: "existing-org-999",
            name: "Acme Corp",
            state: "ORG_STATE_ACTIVE",
            details: { creationDate: "2025-01-01T00:00:00Z" },
          },
        ],
      };
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          status: 409,
          json: async () => ({ code: 6, message: "org already exists" }),
        })
        .mockResolvedValueOnce({
          status: 200,
          json: async () => searchResponse,
        });
      vi.stubGlobal("fetch", mockFetch);

      const client = makeClient();
      const org = await client.createOrg({ name: "Acme Corp" });

      expect(org.orgId).toBe("existing-org-999");
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [searchUrl] = mockFetch.mock.calls[1] as [string];
      expect(searchUrl).toContain("/admin/v1/orgs/_search");
    });

    it("throws on unexpected error status", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          status: 500,
          json: async () => ({ message: "internal error" }),
        }),
      );

      await expect(
        makeClient().createOrg({ name: "Fail Corp" }),
      ).rejects.toThrow("500");
    });
  });

  describe("getOrg", () => {
    it("returns org when found", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          status: 200,
          json: async () => makeGetOrgResponse(),
        }),
      );

      const org = await makeClient().getOrg("zitadel-org-001");
      expect(org).not.toBeNull();
      expect(org?.orgId).toBe("zitadel-org-001");
      expect(org?.name).toBe("Acme Corp");
    });

    it("returns null on 404", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          status: 404,
          json: async () => ({ code: 5, message: "org not found" }),
        }),
      );

      const org = await makeClient().getOrg("nonexistent");
      expect(org).toBeNull();
    });
  });

  describe("createServiceAccount", () => {
    it("creates a machine user and returns account info", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          status: 201,
          json: async () => makeMachineResponse(),
        }),
      );

      const client = makeClient();
      const account = await client.createServiceAccount({
        orgId: "org-123",
        userName: "growthos-sa",
        displayName: "GrowthOS Service Account",
      });

      expect(account.userId).toBe("zitadel-sa-001");
      expect(account.userName).toBe("growthos-sa");
      expect(account.orgId).toBe("org-123");
    });

    it("sends x-zitadel-orgid header", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 201,
        json: async () => makeMachineResponse(),
      });
      vi.stubGlobal("fetch", mockFetch);

      await makeClient().createServiceAccount({
        orgId: "org-456",
        userName: "sa",
        displayName: "SA",
      });

      const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect((opts.headers as Record<string, string>)["x-zitadel-orgid"]).toBe(
        "org-456",
      );
    });
  });

  describe("deleteOrg", () => {
    it("succeeds on 204", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ status: 204, json: async () => ({}) }),
      );
      await expect(makeClient().deleteOrg("org-123")).resolves.toBeUndefined();
    });

    it("silently succeeds on 404", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ status: 404, json: async () => ({}) }),
      );
      await expect(
        makeClient().deleteOrg("nonexistent"),
      ).resolves.toBeUndefined();
    });
  });

  describe("fromEnv()", () => {
    it("throws when ZITADEL_DOMAIN is missing", () => {
      expect(() => HttpZitadelClient.fromEnv({ ZITADEL_TOKEN: "tok" })).toThrow(
        "ZITADEL_DOMAIN",
      );
    });

    it("throws when ZITADEL_TOKEN is missing", () => {
      expect(() =>
        HttpZitadelClient.fromEnv({ ZITADEL_DOMAIN: "http://localhost" }),
      ).toThrow("ZITADEL_TOKEN");
    });

    it("constructs from env vars", () => {
      const client = HttpZitadelClient.fromEnv({
        ZITADEL_DOMAIN: "http://localhost:8080",
        ZITADEL_TOKEN: "my-pat",
      });
      expect(client).toBeInstanceOf(HttpZitadelClient);
    });
  });
});

// ---------------------------------------------------------------------------
// StubZitadelClient
// ---------------------------------------------------------------------------

describe("StubZitadelClient", () => {
  it("creates and retrieves an org", async () => {
    const stub = new StubZitadelClient();
    const org = await stub.createOrg({ name: "Stub Corp" });

    expect(org.orgId).toContain("stub-corp");
    expect(org.state).toBe("ORG_STATE_ACTIVE");

    const retrieved = await stub.getOrg(org.orgId);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.name).toBe("Stub Corp");
  });

  it("returns null for unknown orgId", async () => {
    const stub = new StubZitadelClient();
    expect(await stub.getOrg("unknown")).toBeNull();
  });

  it("deletes an org", async () => {
    const stub = new StubZitadelClient();
    const org = await stub.createOrg({ name: "To Delete" });
    await stub.deleteOrg(org.orgId);
    expect(await stub.getOrg(org.orgId)).toBeNull();
    expect(stub.deleteOrgCalls).toContain(org.orgId);
  });

  it("creates a service account", async () => {
    const stub = new StubZitadelClient();
    const account = await stub.createServiceAccount({
      orgId: "org-001",
      userName: "growthos-sa",
      displayName: "SA",
    });
    expect(account.userId).toContain("growthos-sa");
    expect(account.orgId).toBe("org-001");
  });
});
