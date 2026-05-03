/**
 * SecretManager — Phase 0 / Track E
 *
 * Abstracts secret storage for GrowthOS.  All components that require
 * API keys, tokens, or credentials must use this interface — never read
 * from `process.env` directly in production code.
 *
 * ## Implementations
 *
 * | Class                  | Used in         | Backing store             |
 * |------------------------|-----------------|---------------------------|
 * | `EnvSecretManager`     | dev / CI        | `process.env`             |
 * | `VaultSecretManager`   | production      | OpenBao / HashiCorp Vault |
 *
 * Paths use POSIX-style segments (e.g. `"tenants/tid/openai_api_key"`).
 * The implementations are responsible for mapping paths to their store's
 * native key format.
 *
 * ## Error handling
 *
 * - `get()` returns `null` when the secret does not exist (not found).
 * - `get()` throws on infrastructure errors (network, auth).
 * - `put()` and `delete()` throw on infrastructure errors.
 */

import { z } from "zod";
import { VaultAppRoleAuth } from "./vault-approle-auth.js";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export const secretPathSchema = z
  .string()
  .min(1)
  .regex(
    /^[a-z0-9_/-]+$/,
    "Secret paths may only contain lowercase letters, digits, underscores, hyphens, and slashes",
  );

export type SecretPath = z.infer<typeof secretPathSchema>;

export interface SecretMetadata {
  /** Path relative to the manager's root */
  path: SecretPath;
  /** ISO 8601 creation timestamp (if available from the store) */
  createdAt?: string;
  /** ISO 8601 last-updated timestamp (if available from the store) */
  updatedAt?: string;
  /** KV version number (Vault KV v2) */
  version?: number;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface SecretManager {
  /**
   * Reads the secret value at `path`.
   * @returns The secret string or `null` if the secret does not exist.
   * @throws  On infrastructure error (network, auth, permissions).
   */
  get(path: SecretPath): Promise<string | null>;

  /**
   * Writes (creates or updates) a secret value.
   * @throws On infrastructure error.
   */
  put(path: SecretPath, value: string): Promise<SecretMetadata>;

  /**
   * Deletes a secret.  Silently succeeds if the secret does not exist.
   * @throws On infrastructure error.
   */
  delete(path: SecretPath): Promise<void>;

  /**
   * Lists secret names (not values) under a path prefix.
   * Returns an empty array if the prefix does not exist.
   * @throws On infrastructure error.
   */
  list(prefix: SecretPath): Promise<SecretPath[]>;
}

// ---------------------------------------------------------------------------
// EnvSecretManager — reads from process.env (dev / CI)
// ---------------------------------------------------------------------------

/**
 * Development-only SecretManager that reads from `process.env`.
 *
 * Path segments are uppercased and separators (`/`, `-`) are replaced with
 * `_` to form environment variable names.
 *
 * e.g. `"tenants/abc123/openai_api_key"` → `"TENANTS_ABC123_OPENAI_API_KEY"`
 */
export class EnvSecretManager implements SecretManager {
  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly prefix = "",
  ) {}

  private toEnvKey(path: SecretPath): string {
    const full = this.prefix ? `${this.prefix}/${path}` : path;
    return full.toUpperCase().replace(/[/-]/g, "_");
  }

  async get(path: SecretPath): Promise<string | null> {
    secretPathSchema.parse(path);
    return this.env[this.toEnvKey(path)] ?? null;
  }

  async put(path: SecretPath, value: string): Promise<SecretMetadata> {
    secretPathSchema.parse(path);
    this.env[this.toEnvKey(path)] = value;
    return { path, updatedAt: new Date().toISOString() };
  }

  async delete(path: SecretPath): Promise<void> {
    secretPathSchema.parse(path);
    delete this.env[this.toEnvKey(path)];
  }

  async list(prefix: SecretPath): Promise<SecretPath[]> {
    secretPathSchema.parse(prefix);
    const envPrefix = this.toEnvKey(prefix);
    return Object.keys(this.env)
      .filter((k) => k.startsWith(`${envPrefix}_`))
      .map((k): SecretPath => {
        // Convert env key back to a full scoped path:
        // "TENANTS_ABC_OPENAI_API_KEY" → "tenants/abc/openai_api_key"
        // We only reconstruct the portion after envPrefix_ and append to the
        // original prefix so the result is a valid full path.
        const suffix = k.slice(envPrefix.length + 1).toLowerCase();
        return `${prefix}/${suffix}` as SecretPath;
      })
      .filter((k) => k.length > 0);
  }
}

// ---------------------------------------------------------------------------
// VaultSecretManager — reads from OpenBao / HashiCorp Vault KV v2
// ---------------------------------------------------------------------------

export interface VaultSecretManagerConfig {
  /**
   * Vault base URL, e.g. "http://localhost:8200"
   * Reads from `VAULT_ADDR` env var if not supplied.
   */
  baseUrl: string;
  /**
   * Vault KV v2 mount path, e.g. "secret".
   * Default: "secret".
   */
  mountPath?: string;
  /**
   * Vault token for authentication.
   *
   * Accepts either:
   *   - a static string (simple token auth / dev mode)
   *   - an async resolver `() => Promise<string>` (AppRole, JWT, or any
   *     dynamic auth method that manages its own token lifecycle)
   *
   * Use `VaultAppRoleAuth.getTokenResolver()` to obtain a resolver that
   * handles AppRole login, caching, and renewal automatically.
   */
  token: string | (() => Promise<string>);
  /**
   * Request timeout in milliseconds.  Default: 5000.
   */
  timeoutMs?: number;
}

/**
 * Production SecretManager backed by OpenBao / HashiCorp Vault KV v2.
 *
 * Uses the Vault HTTP API directly (no SDK dependency) — just the
 * `fetch` global that Node 18+ provides.
 *
 * Authentication: static token (inject via `VAULT_TOKEN` env var or
 * `GROWTHOS_VAULT_TOKEN`).  Service-account + AppRole auth is a future
 * upgrade — the interface is identical.
 *
 * Error resilience:
 *   - 404 from the Vault API is mapped to `null` (secret not found).
 *   - All other non-2xx responses throw a descriptive error.
 */
export class VaultSecretManager implements SecretManager {
  private readonly baseUrl: string;
  private readonly mountPath: string;
  private readonly tokenOrResolver: string | (() => Promise<string>);
  private readonly timeoutMs: number;

  constructor(config: VaultSecretManagerConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.mountPath = config.mountPath ?? "secret";
    this.tokenOrResolver = config.token;
    this.timeoutMs = config.timeoutMs ?? 5000;
  }

  /**
   * Factory: builds from environment variables.
   *
   * Auth method selection (in priority order):
   *   1. AppRole — when VAULT_ROLE_ID + VAULT_SECRET_ID are both set.
   *      Handles login, token caching, and renewal automatically.
   *   2. Static token — when VAULT_TOKEN (or GROWTHOS_VAULT_TOKEN) is set.
   *      Suitable for dev mode and root-token-based CI.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): VaultSecretManager {
    const baseUrl = env.VAULT_ADDR ?? env.GROWTHOS_VAULT_ADDR;
    if (!baseUrl)
      throw new Error("VAULT_ADDR or GROWTHOS_VAULT_ADDR is required");

    const roleId = env.VAULT_ROLE_ID ?? env.GROWTHOS_VAULT_ROLE_ID;
    const secretId = env.VAULT_SECRET_ID ?? env.GROWTHOS_VAULT_SECRET_ID;
    if (roleId && secretId) {
      const auth = new VaultAppRoleAuth({ baseUrl, roleId, secretId });
      return new VaultSecretManager({ baseUrl, token: auth.getTokenResolver() });
    }

    const token = env.VAULT_TOKEN ?? env.GROWTHOS_VAULT_TOKEN;
    if (!token)
      throw new Error(
        "VAULT_TOKEN or GROWTHOS_VAULT_TOKEN is required when not using AppRole (VAULT_ROLE_ID + VAULT_SECRET_ID)",
      );
    return new VaultSecretManager({ baseUrl, token });
  }

  private async resolveToken(): Promise<string> {
    return typeof this.tokenOrResolver === "function"
      ? this.tokenOrResolver()
      : this.tokenOrResolver;
  }

  private dataUrl(path: SecretPath): string {
    return `${this.baseUrl}/v1/${this.mountPath}/data/${path}`;
  }

  private metadataUrl(path: SecretPath): string {
    return `${this.baseUrl}/v1/${this.mountPath}/metadata/${path}`;
  }

  private async request(
    method: string,
    url: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const token = await this.resolveToken();
      const res = await fetch(url, {
        method,
        signal: controller.signal,
        headers: {
          "X-Vault-Token": token,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      clearTimeout(timer);
      const json = res.status === 204 ? null : await res.json();
      return { status: res.status, json };
    } catch (err) {
      clearTimeout(timer);
      if ((err as Error).name === "AbortError") {
        throw new Error(
          `Vault request timed out after ${this.timeoutMs}ms: ${url}`,
        );
      }
      throw err;
    }
  }

  async get(path: SecretPath): Promise<string | null> {
    secretPathSchema.parse(path);
    const { status, json } = await this.request("GET", this.dataUrl(path));
    if (status === 404) return null;
    if (status !== 200) {
      throw new Error(
        `Vault GET ${path} returned ${status}: ${JSON.stringify(json)}`,
      );
    }

    const data = (json as { data?: { data?: Record<string, string> } }).data
      ?.data;
    return data?.value ?? null;
  }

  async put(path: SecretPath, value: string): Promise<SecretMetadata> {
    secretPathSchema.parse(path);
    const { status, json } = await this.request("POST", this.dataUrl(path), {
      data: { value },
    });
    if (status !== 200 && status !== 204) {
      throw new Error(
        `Vault PUT ${path} returned ${status}: ${JSON.stringify(json)}`,
      );
    }
    const meta = json as {
      data?: { created_time?: string; updated_time?: string; version?: number };
    };
    const result: SecretMetadata = { path };
    if (meta.data?.created_time) result.createdAt = meta.data.created_time;
    if (meta.data?.updated_time) result.updatedAt = meta.data.updated_time;
    if (meta.data?.version !== undefined) result.version = meta.data.version;
    return result;
  }

  async delete(path: SecretPath): Promise<void> {
    secretPathSchema.parse(path);
    const { status, json } = await this.request(
      "DELETE",
      this.metadataUrl(path),
    );
    if (status !== 204 && status !== 404) {
      throw new Error(
        `Vault DELETE ${path} returned ${status}: ${JSON.stringify(json)}`,
      );
    }
  }

  async list(prefix: SecretPath): Promise<SecretPath[]> {
    secretPathSchema.parse(prefix);
    const url = `${this.baseUrl}/v1/${this.mountPath}/metadata/${prefix}?list=true`;
    const { status, json } = await this.request("GET", url);
    if (status === 404) return [];
    if (status !== 200) {
      throw new Error(
        `Vault LIST ${prefix} returned ${status}: ${JSON.stringify(json)}`,
      );
    }
    const keys = (json as { data?: { keys?: string[] } }).data?.keys ?? [];
    return keys
      .filter((k) => !k.endsWith("/"))
      .map((k): SecretPath => `${prefix}/${k}` as SecretPath);
  }
}
