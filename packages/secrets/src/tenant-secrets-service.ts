/**
 * TenantSecretsService — Phase 0 / Track E
 *
 * Scoped wrapper over `SecretManager` for per-tenant secrets.
 *
 * All secret paths are namespaced under `tenants/{tenantId}/{key}` so
 * multiple tenants can never read each other's secrets — even if the
 * underlying `SecretManager` does not enforce RLS.
 *
 * ## Well-known secret keys
 *
 * | Key                   | Description                              |
 * |-----------------------|------------------------------------------|
 * | `openai_api_key`      | Tenant's OpenAI API key                  |
 * | `paperclip_api_token` | Paperclip agent control-plane token       |
 * | `gitea_token`         | Gitea user token for workspace repos     |
 * | `minio_access_key`    | MinIO / S3 access key ID                 |
 * | `minio_secret_key`    | MinIO / S3 secret access key             |
 * | `nats_credentials`    | NATS NKey seed or credentials file body  |
 */

import { z } from "zod";
import {
  type SecretManager,
  type SecretMetadata,
  secretPathSchema,
} from "./secret-manager.js";

// ---------------------------------------------------------------------------
// Well-known keys enum (for autocomplete; open for extension)
// ---------------------------------------------------------------------------

export const WELL_KNOWN_SECRET_KEYS = [
  "openai_api_key",
  "paperclip_api_token",
  "gitea_token",
  "minio_access_key",
  "minio_secret_key",
  "nats_credentials",
] as const;

export type WellKnownSecretKey = (typeof WELL_KNOWN_SECRET_KEYS)[number];

export const tenantIdSchema = z.string().uuid();

// ---------------------------------------------------------------------------
// TenantSecretsService
// ---------------------------------------------------------------------------

export class TenantSecretsService {
  constructor(private readonly manager: SecretManager) {}

  private scopedPath(
    tenantId: string,
    key: string,
  ): ReturnType<typeof secretPathSchema.parse> {
    tenantIdSchema.parse(tenantId);
    const path = `tenants/${tenantId}/${key}`;
    return secretPathSchema.parse(path);
  }

  /**
   * Reads a secret for the given tenant.
   * @returns The secret value or `null` if not set.
   */
  async get(tenantId: string, key: string): Promise<string | null> {
    return this.manager.get(this.scopedPath(tenantId, key));
  }

  /**
   * Writes (creates or updates) a tenant secret.
   */
  async put(
    tenantId: string,
    key: string,
    value: string,
  ): Promise<SecretMetadata> {
    return this.manager.put(this.scopedPath(tenantId, key), value);
  }

  /**
   * Deletes a tenant secret.  Silently succeeds if the secret does not exist.
   */
  async delete(tenantId: string, key: string): Promise<void> {
    return this.manager.delete(this.scopedPath(tenantId, key));
  }

  /**
   * Lists all secret keys provisioned for a tenant.
   * Returns just the key names (not the full paths).
   */
  async listKeys(tenantId: string): Promise<string[]> {
    tenantIdSchema.parse(tenantId);
    const prefix = secretPathSchema.parse(`tenants/${tenantId}`);
    const paths = await this.manager.list(prefix);
    const prefixWithSlash = `${prefix}/`;
    return paths.map((p) => p.slice(prefixWithSlash.length)).filter(Boolean);
  }

  /**
   * Provisions all well-known secrets for a new tenant from a flat map.
   * Silently skips keys with undefined values.
   *
   * Designed for the tenant provisioning flow:
   *   `await service.provisionTenant(tenantId, { openai_api_key: "sk-..." })`
   */
  async provisionTenant(
    tenantId: string,
    secrets: Partial<Record<WellKnownSecretKey, string>> &
      Record<string, string>,
  ): Promise<void> {
    const writes = Object.entries(secrets)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([key, value]) => this.put(tenantId, key, value as string));
    await Promise.all(writes);
  }
}
