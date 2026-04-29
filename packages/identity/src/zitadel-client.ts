/**
 * ZitadelClient — Zitadel identity management for GrowthOS.
 *
 * Implements the org-per-tenant model: every tenant gets an isolated Zitadel
 * organisation so users, roles, and permissions are fully namespaced.
 *
 * Auth: Personal Access Token (PAT) or service-account JWT passed as
 * `Authorization: Bearer <token>`.
 *
 * All methods are idempotent where noted — safe to call in a Restate
 * `ctx.run(...)` block or inside a retry loop.
 *
 * Zitadel API docs: https://zitadel.com/docs/apis/resources/admin
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export const zitadelOrgSchema = z.object({
  orgId: z.string().min(1),
  name: z.string().min(1),
  primaryDomain: z.string().optional(),
  state: z.enum(["ORG_STATE_ACTIVE", "ORG_STATE_INACTIVE"]).optional(),
  createdAt: z.string().optional(),
});

export type ZitadelOrg = z.infer<typeof zitadelOrgSchema>;

export const zitadelServiceAccountSchema = z.object({
  userId: z.string().min(1),
  userName: z.string().min(1),
  orgId: z.string().min(1),
  createdAt: z.string().optional(),
});

export type ZitadelServiceAccount = z.infer<typeof zitadelServiceAccountSchema>;

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface ZitadelClient {
  /**
   * Creates a Zitadel organisation for a tenant.
   * Idempotent by name: if an org with the same name already exists, returns it.
   * @returns The created (or existing) org.
   */
  createOrg(params: {
    name: string;
    primaryDomain?: string;
  }): Promise<ZitadelOrg>;

  /**
   * Returns the org by ID, or null if it does not exist.
   */
  getOrg(orgId: string): Promise<ZitadelOrg | null>;

  /**
   * Creates an M2M service account (machine user) inside the org.
   * Idempotent by userName within the org.
   */
  createServiceAccount(params: {
    orgId: string;
    userName: string;
    displayName: string;
  }): Promise<ZitadelServiceAccount>;

  /**
   * Permanently deletes the org and all its users/data.
   * Silently succeeds if the org does not exist.
   */
  deleteOrg(orgId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ZitadelClientConfig {
  /**
   * Zitadel instance URL, e.g. "https://auth.growthos.io"
   * Reads from ZITADEL_DOMAIN env var if not provided.
   */
  baseUrl: string;
  /**
   * PAT or service-account access token.
   * Reads from ZITADEL_TOKEN or GROWTHOS_ZITADEL_TOKEN if not provided.
   */
  token: string;
  /** Request timeout in milliseconds. Default: 8000 */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// HttpZitadelClient
// ---------------------------------------------------------------------------

export class HttpZitadelClient implements ZitadelClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(config: ZitadelClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.token = config.token;
    this.timeoutMs = config.timeoutMs ?? 8000;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): HttpZitadelClient {
    const baseUrl = env.ZITADEL_DOMAIN ?? env.GROWTHOS_ZITADEL_DOMAIN;
    if (!baseUrl)
      throw new Error("ZITADEL_DOMAIN or GROWTHOS_ZITADEL_DOMAIN is required");

    const token = env.ZITADEL_TOKEN ?? env.GROWTHOS_ZITADEL_TOKEN;
    if (!token)
      throw new Error("ZITADEL_TOKEN or GROWTHOS_ZITADEL_TOKEN is required");

    return new HttpZitadelClient({ baseUrl, token });
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; json: T }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      clearTimeout(timer);
      const json = res.status === 204 ? ({} as T) : ((await res.json()) as T);
      return { status: res.status, json };
    } catch (err) {
      clearTimeout(timer);
      if ((err as Error).name === "AbortError")
        throw new Error(`Zitadel request timed out after ${this.timeoutMs}ms: ${path}`);
      throw err;
    }
  }

  async createOrg(params: { name: string; primaryDomain?: string }): Promise<ZitadelOrg> {
    type CreateOrgResponse = { orgId?: string; createdAt?: string };
    const { status, json } = await this.request<CreateOrgResponse>(
      "POST",
      "/admin/v1/orgs",
      { name: params.name, ...(params.primaryDomain ? { primaryDomain: params.primaryDomain } : {}) },
    );

    // 409 Conflict = org already exists — look it up by name
    if (status === 409) {
      return this.findOrgByName(params.name);
    }

    if (status !== 200 && status !== 201) {
      throw new Error(`Zitadel createOrg failed (${status}): ${JSON.stringify(json)}`);
    }

    if (!json.orgId) throw new Error("Zitadel createOrg response missing orgId");
    return { orgId: json.orgId, name: params.name, state: "ORG_STATE_ACTIVE", createdAt: json.createdAt };
  }

  async getOrg(orgId: string): Promise<ZitadelOrg | null> {
    type GetOrgResponse = { org?: { id?: string; name?: string; primaryDomain?: string; state?: string; details?: { creationDate?: string } } };
    const { status, json } = await this.request<GetOrgResponse>("GET", `/admin/v1/orgs/${orgId}`);
    if (status === 404) return null;
    if (status !== 200)
      throw new Error(`Zitadel getOrg ${orgId} failed (${status}): ${JSON.stringify(json)}`);

    const o = json.org;
    if (!o?.id) return null;
    return {
      orgId: o.id,
      name: o.name ?? "",
      primaryDomain: o.primaryDomain,
      state: (o.state as ZitadelOrg["state"]) ?? "ORG_STATE_ACTIVE",
      createdAt: o.details?.creationDate,
    };
  }

  async createServiceAccount(params: {
    orgId: string;
    userName: string;
    displayName: string;
  }): Promise<ZitadelServiceAccount> {
    type CreateMachineResponse = { userId?: string; createdAt?: string };
    const { status, json } = await this.request<CreateMachineResponse>(
      "POST",
      "/management/v1/machines",
      { userName: params.userName, name: params.displayName, accessTokenType: "ACCESS_TOKEN_TYPE_JWT" },
      { "x-zitadel-orgid": params.orgId },
    );

    if (status === 409) {
      // Machine already exists — find it
      return this.findServiceAccount(params.orgId, params.userName);
    }

    if (status !== 200 && status !== 201)
      throw new Error(`Zitadel createServiceAccount failed (${status}): ${JSON.stringify(json)}`);

    if (!json.userId) throw new Error("Zitadel createServiceAccount response missing userId");
    return { userId: json.userId, userName: params.userName, orgId: params.orgId, createdAt: json.createdAt };
  }

  async deleteOrg(orgId: string): Promise<void> {
    const { status, json } = await this.request<unknown>("DELETE", `/admin/v1/orgs/${orgId}`);
    if (status === 404 || status === 204 || status === 200) return;
    throw new Error(`Zitadel deleteOrg ${orgId} failed (${status}): ${JSON.stringify(json)}`);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async findOrgByName(name: string): Promise<ZitadelOrg> {
    type SearchResponse = {
      result?: Array<{ id?: string; name?: string; primaryDomain?: string; state?: string; details?: { creationDate?: string } }>;
    };
    const { status, json } = await this.request<SearchResponse>(
      "POST",
      "/admin/v1/orgs/_search",
      { queries: [{ nameQuery: { name, method: "TEXT_QUERY_METHOD_EQUALS" } }] },
    );
    if (status !== 200)
      throw new Error(`Zitadel org search failed (${status}): ${JSON.stringify(json)}`);

    const match = json.result?.[0];
    if (!match?.id) throw new Error(`Zitadel org not found after 409: name=${name}`);
    return {
      orgId: match.id,
      name: match.name ?? name,
      primaryDomain: match.primaryDomain,
      state: (match.state as ZitadelOrg["state"]) ?? "ORG_STATE_ACTIVE",
      createdAt: match.details?.creationDate,
    };
  }

  private async findServiceAccount(orgId: string, userName: string): Promise<ZitadelServiceAccount> {
    type SearchResponse = {
      result?: Array<{ id?: string; userName?: string }>;
    };
    const { status, json } = await this.request<SearchResponse>(
      "POST",
      "/management/v1/users/_search",
      { queries: [{ userNameQuery: { userName, method: "TEXT_QUERY_METHOD_EQUALS" } }] },
      { "x-zitadel-orgid": orgId },
    );
    if (status !== 200)
      throw new Error(`Zitadel user search failed (${status}): ${JSON.stringify(json)}`);

    const match = json.result?.[0];
    if (!match?.id) throw new Error(`Zitadel service account not found after 409: userName=${userName}`);
    return { userId: match.id, userName: match.userName ?? userName, orgId };
  }
}

// ---------------------------------------------------------------------------
// StubZitadelClient — for tests and local dev
// ---------------------------------------------------------------------------

export class StubZitadelClient implements ZitadelClient {
  readonly createOrgCalls: Parameters<ZitadelClient["createOrg"]>[0][] = [];
  readonly deleteOrgCalls: string[] = [];

  private orgs = new Map<string, ZitadelOrg>();
  private accounts = new Map<string, ZitadelServiceAccount>();

  async createOrg(params: Parameters<ZitadelClient["createOrg"]>[0]): Promise<ZitadelOrg> {
    this.createOrgCalls.push(params);
    const orgId = `zitadel-org-${params.name.toLowerCase().replace(/\s+/g, "-")}`;
    const org: ZitadelOrg = { orgId, name: params.name, state: "ORG_STATE_ACTIVE", createdAt: new Date().toISOString() };
    this.orgs.set(orgId, org);
    return org;
  }

  async getOrg(orgId: string): Promise<ZitadelOrg | null> {
    return this.orgs.get(orgId) ?? null;
  }

  async createServiceAccount(params: Parameters<ZitadelClient["createServiceAccount"]>[0]): Promise<ZitadelServiceAccount> {
    const userId = `zitadel-sa-${params.userName}`;
    const account: ZitadelServiceAccount = { userId, userName: params.userName, orgId: params.orgId, createdAt: new Date().toISOString() };
    this.accounts.set(userId, account);
    return account;
  }

  async deleteOrg(orgId: string): Promise<void> {
    this.deleteOrgCalls.push(orgId);
    this.orgs.delete(orgId);
  }
}
