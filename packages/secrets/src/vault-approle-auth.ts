/**
 * VaultAppRoleAuth — AppRole authentication for OpenBao / HashiCorp Vault.
 *
 * AppRole is the recommended non-human auth method for services running inside
 * Kubernetes or other automated environments.  It uses two credentials:
 *
 *   role_id    — static, identifies the service role (safe to store in config)
 *   secret_id  — short-lived, rotated regularly (treat as a secret)
 *
 * Auth flow:
 *   1. POST /v1/auth/approle/login → client_token + lease_duration
 *   2. Use client_token as X-Vault-Token on all subsequent calls
 *   3. When < 30% of the lease remains: POST /v1/auth/token/renew-self
 *   4. On renewal failure (revoked, non-renewable): re-login
 *
 * Usage with VaultSecretManager:
 *   const auth = VaultAppRoleAuth.fromEnv();
 *   const manager = new VaultSecretManager({
 *     baseUrl: "http://openbao:8200",
 *     token: auth.getTokenResolver(),
 *   });
 *
 * Environment variables:
 *   VAULT_ADDR or GROWTHOS_VAULT_ADDR  — Vault base URL
 *   VAULT_ROLE_ID or GROWTHOS_VAULT_ROLE_ID
 *   VAULT_SECRET_ID or GROWTHOS_VAULT_SECRET_ID
 */

export interface AppRoleAuthConfig {
  /** Vault base URL, e.g. "http://localhost:8200" */
  baseUrl: string;
  /** AppRole role ID (static, not secret) */
  roleId: string;
  /** AppRole secret ID (short-lived, rotated) */
  secretId: string;
  /**
   * Auth mount path.  Default: "approle"
   * (maps to /v1/auth/approle/login)
   */
  mountPath?: string;
  /** Request timeout in milliseconds.  Default: 5000 */
  timeoutMs?: number;
}

interface CachedToken {
  token: string;
  /** Unix timestamp in seconds when this token expires */
  expiresAt: number;
  /** Original lease_duration in seconds — used to compute the renewal window */
  leaseDuration: number;
  renewable: boolean;
}

// Renew when this fraction of the lease duration remains.
const RENEWAL_THRESHOLD = 0.3;

export class VaultAppRoleAuth {
  private readonly baseUrl: string;
  private readonly roleId: string;
  private readonly secretId: string;
  private readonly mountPath: string;
  private readonly timeoutMs: number;
  private cached: CachedToken | null = null;

  constructor(config: AppRoleAuthConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.roleId = config.roleId;
    this.secretId = config.secretId;
    this.mountPath = config.mountPath ?? "approle";
    this.timeoutMs = config.timeoutMs ?? 5000;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): VaultAppRoleAuth {
    const baseUrl = env.VAULT_ADDR ?? env.GROWTHOS_VAULT_ADDR;
    const roleId = env.VAULT_ROLE_ID ?? env.GROWTHOS_VAULT_ROLE_ID;
    const secretId = env.VAULT_SECRET_ID ?? env.GROWTHOS_VAULT_SECRET_ID;

    if (!baseUrl)
      throw new Error("VAULT_ADDR or GROWTHOS_VAULT_ADDR is required");
    if (!roleId)
      throw new Error(
        "VAULT_ROLE_ID or GROWTHOS_VAULT_ROLE_ID is required for AppRole auth",
      );
    if (!secretId)
      throw new Error(
        "VAULT_SECRET_ID or GROWTHOS_VAULT_SECRET_ID is required for AppRole auth",
      );

    return new VaultAppRoleAuth({ baseUrl, roleId, secretId });
  }

  /**
   * Returns a token resolver function for use as `VaultSecretManagerConfig.token`.
   * The resolver always returns a valid, non-expired token — renewing or
   * re-logging in transparently as needed.
   */
  getTokenResolver(): () => Promise<string> {
    return () => this.resolveToken();
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
  }

  private async resolveToken(): Promise<string> {
    const cached = this.cached;

    if (cached && this.nowSeconds() < cached.expiresAt) {
      const remaining = cached.expiresAt - this.nowSeconds();
      const renewalWindow = cached.leaseDuration * RENEWAL_THRESHOLD;

      if (remaining > renewalWindow) {
        return cached.token; // Still comfortably within lease
      }

      // Token valid but approaching expiry — attempt renewal.
      if (cached.renewable) {
        try {
          await this.renew(cached.token);
          const renewed = this.cached;
          if (renewed) return renewed.token;
        } catch {
          // Renewal failed (e.g. token revoked) — fall through to re-login.
          this.cached = null;
        }
      }
    }

    // Cache miss, expired, or renewal failed.
    await this.login();
    const loggedIn = this.cached;
    if (!loggedIn) {
      throw new Error("Vault AppRole login did not cache a token");
    }
    return loggedIn.token;
  }

  private async vaultFetch(
    url: string,
    body: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; json: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...extraHeaders,
        },
        body: JSON.stringify(body),
      });
      clearTimeout(timer);
      const json = await res.json();
      return { status: res.status, json };
    } catch (err) {
      clearTimeout(timer);
      if ((err as Error).name === "AbortError") {
        throw new Error(
          `Vault AppRole request timed out after ${this.timeoutMs}ms: ${url}`,
        );
      }
      throw err;
    }
  }

  private async login(): Promise<void> {
    const url = `${this.baseUrl}/v1/auth/${this.mountPath}/login`;
    const { status, json } = await this.vaultFetch(url, {
      role_id: this.roleId,
      secret_id: this.secretId,
    });

    if (status !== 200) {
      throw new Error(
        `Vault AppRole login failed (${status}): ${JSON.stringify(json)}`,
      );
    }

    const auth = (
      json as {
        auth?: {
          client_token: string;
          lease_duration: number;
          renewable: boolean;
        };
      }
    ).auth;

    if (!auth?.client_token) {
      throw new Error("Vault AppRole login response missing auth.client_token");
    }

    const now = this.nowSeconds();
    this.cached = {
      token: auth.client_token,
      expiresAt: now + auth.lease_duration,
      leaseDuration: auth.lease_duration,
      renewable: auth.renewable ?? false,
    };
  }

  private async renew(currentToken: string): Promise<void> {
    const url = `${this.baseUrl}/v1/auth/token/renew-self`;
    const { status, json } = await this.vaultFetch(
      url,
      {},
      { "X-Vault-Token": currentToken },
    );

    if (status !== 200) {
      throw new Error(
        `Vault token renewal failed (${status}): ${JSON.stringify(json)}`,
      );
    }

    const auth = (
      json as {
        auth?: {
          client_token: string;
          lease_duration: number;
          renewable: boolean;
        };
      }
    ).auth;

    if (!auth) {
      throw new Error("Vault token renewal response missing auth");
    }

    const now = this.nowSeconds();
    this.cached = {
      token: auth.client_token ?? currentToken,
      expiresAt: now + auth.lease_duration,
      leaseDuration: auth.lease_duration,
      renewable: auth.renewable ?? false,
    };
  }
}
