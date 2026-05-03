import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EnvSecretManager,
  VaultSecretManager,
  secretPathSchema,
} from "./secret-manager.js";
import { TenantSecretsService } from "./tenant-secrets-service.js";
import { VaultAppRoleAuth } from "./vault-approle-auth.js";

const TENANT_ID = "00000000-0000-4000-8000-000000000001";

// ---------------------------------------------------------------------------
// secretPathSchema
// ---------------------------------------------------------------------------

describe("secretPathSchema", () => {
  it("accepts valid paths", () => {
    expect(() =>
      secretPathSchema.parse("tenants/abc123/openai_api_key"),
    ).not.toThrow();
    expect(() => secretPathSchema.parse("global/stripe_key")).not.toThrow();
    expect(() => secretPathSchema.parse("a-b/c_d/e1")).not.toThrow();
  });

  it("rejects empty paths", () => {
    expect(() => secretPathSchema.parse("")).toThrow();
  });

  it("rejects paths with uppercase letters", () => {
    expect(() => secretPathSchema.parse("Tenants/API_KEY")).toThrow();
  });

  it("rejects paths with spaces", () => {
    expect(() => secretPathSchema.parse("tenants/my tenant/key")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// EnvSecretManager
// ---------------------------------------------------------------------------

describe("EnvSecretManager", () => {
  const fakeEnv: NodeJS.ProcessEnv = {};
  const manager = new EnvSecretManager(fakeEnv);

  afterEach(() => {
    for (const key of Object.keys(fakeEnv)) {
      delete fakeEnv[key];
    }
  });

  it("returns null when secret is not set", async () => {
    const result = await manager.get("tenants/abc/openai_api_key");
    expect(result).toBeNull();
  });

  it("returns value after put", async () => {
    await manager.put("tenants/abc/openai_api_key", "sk-test-123");
    const result = await manager.get("tenants/abc/openai_api_key");
    expect(result).toBe("sk-test-123");
  });

  it("maps path to uppercase env key with underscores", async () => {
    await manager.put("tenants/abc/openai_api_key", "sk-1");
    expect(fakeEnv.TENANTS_ABC_OPENAI_API_KEY).toBe("sk-1");
  });

  it("deletes secret successfully", async () => {
    await manager.put("tenants/abc/my_key", "val");
    await manager.delete("tenants/abc/my_key");
    const result = await manager.get("tenants/abc/my_key");
    expect(result).toBeNull();
  });

  it("list returns keys matching prefix", async () => {
    await manager.put("tenants/t1/key_a", "a");
    await manager.put("tenants/t1/key_b", "b");
    await manager.put("tenants/t2/key_c", "c"); // different tenant
    const keys = await manager.list("tenants/t1");
    expect(keys).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// VaultSecretManager — unit tests with mocked fetch
// ---------------------------------------------------------------------------

const makeVaultManager = () =>
  new VaultSecretManager({
    baseUrl: "http://localhost:8200",
    token: "test-root-token",
  });

const mockFetchJson = (status: number, body: unknown) => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      status,
      json: async () => body,
    }),
  );
};

describe("VaultSecretManager", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GET returns null on 404", async () => {
    mockFetchJson(404, {});
    const manager = makeVaultManager();
    const result = await manager.get("tenants/abc/openai_api_key");
    expect(result).toBeNull();
  });

  it("GET returns value from KV v2 data.data.value", async () => {
    mockFetchJson(200, {
      data: { data: { value: "sk-prod-key" }, metadata: {} },
    });
    const manager = makeVaultManager();
    const result = await manager.get("tenants/abc/openai_api_key");
    expect(result).toBe("sk-prod-key");
  });

  it("GET throws on non-200/404 status", async () => {
    mockFetchJson(403, { errors: ["permission denied"] });
    const manager = makeVaultManager();
    await expect(manager.get("tenants/abc/key")).rejects.toThrow("403");
  });

  it("PUT sends POST to /data path with correct body", async () => {
    const mockFn = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({
        data: {
          created_time: "2026-04-28T00:00:00Z",
          updated_time: "2026-04-28T00:00:00Z",
          version: 1,
        },
      }),
    });
    vi.stubGlobal("fetch", mockFn);

    const manager = makeVaultManager();
    const meta = await manager.put("tenants/abc/openai_api_key", "sk-new");

    expect(meta.version).toBe(1);
    const callArg = mockFn.mock.calls[0] as [string, RequestInit];
    expect(callArg[0]).toContain("/v1/secret/data/tenants/abc/openai_api_key");
    expect(JSON.parse(callArg[1].body as string)).toEqual({
      data: { value: "sk-new" },
    });
  });

  it("DELETE silently succeeds on 204", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 204, json: async () => null }),
    );
    const manager = makeVaultManager();
    await expect(
      manager.delete("tenants/abc/openai_api_key"),
    ).resolves.not.toThrow();
  });

  it("LIST returns empty array on 404", async () => {
    mockFetchJson(404, {});
    const manager = makeVaultManager();
    const keys = await manager.list("tenants/abc");
    expect(keys).toEqual([]);
  });

  it("LIST returns scoped paths from Vault keys", async () => {
    mockFetchJson(200, {
      data: { keys: ["openai_api_key", "gitea_token", "subfolder/"] },
    });
    const manager = makeVaultManager();
    const keys = await manager.list("tenants/abc");
    // Trailing-slash entries (subdirectories) are excluded.
    expect(keys).toContain("tenants/abc/openai_api_key");
    expect(keys).toContain("tenants/abc/gitea_token");
    expect(keys).not.toContain(expect.stringContaining("subfolder/"));
  });

  it("fromEnv() throws when VAULT_ADDR is missing", () => {
    expect(() => VaultSecretManager.fromEnv({})).toThrow("VAULT_ADDR");
  });

  it("fromEnv() constructs manager from env vars", () => {
    const manager = VaultSecretManager.fromEnv({
      VAULT_ADDR: "http://openbao:8200",
      VAULT_TOKEN: "test-token",
    });
    expect(manager).toBeInstanceOf(VaultSecretManager);
  });
});

// ---------------------------------------------------------------------------
// VaultAppRoleAuth
// ---------------------------------------------------------------------------

const makeLoginResponse = (overrides: Partial<{
  client_token: string;
  lease_duration: number;
  renewable: boolean;
}> = {}) => ({
  auth: {
    client_token: "s.approle-token-abc",
    lease_duration: 3600,
    renewable: true,
    ...overrides,
  },
});

const makeRenewResponse = (overrides: Partial<{
  client_token: string;
  lease_duration: number;
  renewable: boolean;
}> = {}) => ({
  auth: {
    client_token: "s.approle-token-abc",
    lease_duration: 3600,
    renewable: true,
    ...overrides,
  },
});

const makeAppRoleAuth = (overrides: Partial<ConstructorParameters<typeof VaultAppRoleAuth>[0]> = {}) =>
  new VaultAppRoleAuth({
    baseUrl: "http://localhost:8200",
    roleId: "test-role-id",
    secretId: "test-secret-id",
    ...overrides,
  });

describe("VaultAppRoleAuth", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("performs AppRole login on first resolveToken() call", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      status: 200,
      json: async () => makeLoginResponse(),
    });
    vi.stubGlobal("fetch", mockFetch);

    const auth = makeAppRoleAuth();
    const resolver = auth.getTokenResolver();
    const token = await resolver();

    expect(token).toBe("s.approle-token-abc");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1/auth/approle/login");
    expect(JSON.parse(opts.body as string)).toMatchObject({
      role_id: "test-role-id",
      secret_id: "test-secret-id",
    });
  });

  it("returns cached token on second call without re-logging in", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => makeLoginResponse({ lease_duration: 3600 }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const auth = makeAppRoleAuth();
    const resolver = auth.getTokenResolver();
    await resolver(); // first call — login
    await resolver(); // second call — cached

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("renews token when within the renewal window (< 30% remaining)", async () => {
    // 100s lease → renewalWindow = 30s. Advance 75s so remaining = 25s < 30s.
    vi.useFakeTimers();
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        json: async () => makeLoginResponse({ lease_duration: 100 }),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: async () => makeRenewResponse({ lease_duration: 3600 }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const auth = makeAppRoleAuth();
    const resolver = auth.getTokenResolver();
    await resolver(); // login
    vi.setSystemTime(Date.now() + 75_000); // advance 75s → 25s remaining < 30s window
    const token = await resolver(); // within renewal window → renew

    expect(token).toBe("s.approle-token-abc");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [renewUrl] = mockFetch.mock.calls[1] as [string];
    expect(renewUrl).toContain("/v1/auth/token/renew-self");
    vi.useRealTimers();
  });

  it("re-logins when token renewal fails", async () => {
    // 100s lease → renewalWindow = 30s. Advance 75s to enter window, then renewal 403 → re-login.
    vi.useFakeTimers();
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        json: async () => makeLoginResponse({ lease_duration: 100 }),
      })
      .mockResolvedValueOnce({
        // Renewal returns 403 (token was revoked)
        status: 403,
        json: async () => ({ errors: ["permission denied"] }),
      })
      .mockResolvedValueOnce({
        // Re-login succeeds with new token
        status: 200,
        json: async () => makeLoginResponse({ client_token: "s.new-token", lease_duration: 3600 }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const auth = makeAppRoleAuth();
    const resolver = auth.getTokenResolver();
    await resolver(); // login
    vi.setSystemTime(Date.now() + 75_000); // advance into renewal window
    const token = await resolver(); // renewal fails → re-login

    expect(token).toBe("s.new-token");
    expect(mockFetch).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("throws when AppRole login returns non-200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 400,
        json: async () => ({ errors: ["invalid role_id"] }),
      }),
    );

    const auth = makeAppRoleAuth();
    const resolver = auth.getTokenResolver();
    await expect(resolver()).rejects.toThrow("AppRole login failed");
  });

  it("fromEnv() throws when VAULT_ROLE_ID is missing", () => {
    expect(() =>
      VaultAppRoleAuth.fromEnv({
        VAULT_ADDR: "http://localhost:8200",
        VAULT_SECRET_ID: "sid",
      }),
    ).toThrow("VAULT_ROLE_ID");
  });

  it("fromEnv() constructs from env vars", () => {
    const auth = VaultAppRoleAuth.fromEnv({
      VAULT_ADDR: "http://openbao:8200",
      VAULT_ROLE_ID: "role-abc",
      VAULT_SECRET_ID: "secret-xyz",
    });
    expect(auth).toBeInstanceOf(VaultAppRoleAuth);
  });
});

// ---------------------------------------------------------------------------
// VaultSecretManager with token resolver
// ---------------------------------------------------------------------------

describe("VaultSecretManager — token resolver", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("calls the resolver function on each request rather than caching statically", async () => {
    let callCount = 0;
    const resolver = async () => {
      callCount += 1;
      return `token-${callCount}`;
    };

    const manager = new VaultSecretManager({
      baseUrl: "http://localhost:8200",
      token: resolver,
    });

    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ data: { data: { value: "sk-secret" } } }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await manager.get("tenants/abc/openai_api_key");
    await manager.get("tenants/abc/openai_api_key");

    // Resolver must have been called once per request.
    expect(callCount).toBe(2);
    const headers0 = (mockFetch.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>;
    const headers1 = (mockFetch.mock.calls[1] as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers0["X-Vault-Token"]).toBe("token-1");
    expect(headers1["X-Vault-Token"]).toBe("token-2");
  });
});

// ---------------------------------------------------------------------------
// VaultSecretManager.fromEnv() — auth method selection
// ---------------------------------------------------------------------------

describe("VaultSecretManager.fromEnv() auth selection", () => {
  it("uses AppRole when VAULT_ROLE_ID + VAULT_SECRET_ID are set", () => {
    const manager = VaultSecretManager.fromEnv({
      VAULT_ADDR: "http://localhost:8200",
      VAULT_ROLE_ID: "role-abc",
      VAULT_SECRET_ID: "secret-xyz",
    });
    expect(manager).toBeInstanceOf(VaultSecretManager);
    // Token is a resolver function, not a static string.
    // We can't directly inspect the private field so we just confirm it constructs.
  });

  it("uses static token when only VAULT_TOKEN is set", () => {
    const manager = VaultSecretManager.fromEnv({
      VAULT_ADDR: "http://localhost:8200",
      VAULT_TOKEN: "s.root-dev-token",
    });
    expect(manager).toBeInstanceOf(VaultSecretManager);
  });

  it("throws when neither AppRole nor static token env vars are provided", () => {
    expect(() =>
      VaultSecretManager.fromEnv({ VAULT_ADDR: "http://localhost:8200" }),
    ).toThrow("VAULT_TOKEN");
  });
});

// ---------------------------------------------------------------------------
// TenantSecretsService
// ---------------------------------------------------------------------------

describe("TenantSecretsService", () => {
  const makeService = () => {
    const env: NodeJS.ProcessEnv = {};
    const manager = new EnvSecretManager(env);
    const service = new TenantSecretsService(manager);
    return { service, manager };
  };

  it("get returns null when secret is not set", async () => {
    const { service } = makeService();
    expect(await service.get(TENANT_ID, "openai_api_key")).toBeNull();
  });

  it("put then get round-trips a secret", async () => {
    const { service } = makeService();
    await service.put(TENANT_ID, "openai_api_key", "sk-123");
    expect(await service.get(TENANT_ID, "openai_api_key")).toBe("sk-123");
  });

  it("delete removes the secret", async () => {
    const { service } = makeService();
    await service.put(TENANT_ID, "gitea_token", "ghp-xxx");
    await service.delete(TENANT_ID, "gitea_token");
    expect(await service.get(TENANT_ID, "gitea_token")).toBeNull();
  });

  it("listKeys returns just key names, not full paths", async () => {
    const { service } = makeService();
    await service.put(TENANT_ID, "openai_api_key", "sk-1");
    await service.put(TENANT_ID, "gitea_token", "ghp-1");
    const keys = await service.listKeys(TENANT_ID);
    expect(keys).toContain("openai_api_key");
    expect(keys).toContain("gitea_token");
  });

  it("provisionTenant writes all supplied secrets in parallel", async () => {
    const { service } = makeService();
    await service.provisionTenant(TENANT_ID, {
      openai_api_key: "sk-1",
      gitea_token: "ghp-1",
      minio_access_key: "minio-key",
    });
    expect(await service.get(TENANT_ID, "openai_api_key")).toBe("sk-1");
    expect(await service.get(TENANT_ID, "gitea_token")).toBe("ghp-1");
    expect(await service.get(TENANT_ID, "minio_access_key")).toBe("minio-key");
  });

  it("provisionTenant skips empty-string values", async () => {
    const { service } = makeService();
    await service.provisionTenant(TENANT_ID, {
      openai_api_key: "sk-1",
      gitea_token: "",
    });
    expect(await service.get(TENANT_ID, "gitea_token")).toBeNull();
  });

  it("rejects invalid tenantId", async () => {
    const { service } = makeService();
    await expect(service.get("not-a-uuid", "openai_api_key")).rejects.toThrow();
  });
});
