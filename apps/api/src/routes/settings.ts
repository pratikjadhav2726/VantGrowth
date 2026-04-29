/**
 * /v1/settings — tenant settings persistence.
 *
 *   GET  /v1/settings  — retrieve settings document for the tenant
 *   PATCH /v1/settings — shallow-merge patch into tenant settings
 *
 * Settings are stored as a single JSONB document per tenant in
 * `growthos.tenant_settings`, enforced by Postgres RLS.  The GET endpoint
 * is intentionally unauthenticated so the web shell can bootstrap
 * non-sensitive UI prefs without a service token.  The PATCH endpoint
 * requires the API bearer token (wired in app.ts).
 */

import type { TenantSettingsRepository } from "@growthos/db";
import { Hono } from "hono";
import { z } from "zod";
import { ServiceUnavailableError } from "../http-errors.js";

export interface SettingsDeps {
  tenantSettingsRepository: TenantSettingsRepository | null;
}

const settingsPatchSchema = z.record(z.unknown());

export function createSettingsRoutes(deps: SettingsDeps) {
  const route = new Hono();

  // GET /v1/settings
  route.get("/", async (c) => {
    const tenantId = c.req.header("X-Tenant-Id");
    if (!tenantId)
      return c.json({ error: "X-Tenant-Id header is required" }, 400);

    if (!deps.tenantSettingsRepository)
      throw new ServiceUnavailableError("Settings store not configured");

    const settings = await deps.tenantSettingsRepository.get(tenantId);
    return c.json({ tenantId, settings });
  });

  // PATCH /v1/settings
  route.patch("/", async (c) => {
    const tenantId = c.req.header("X-Tenant-Id");
    if (!tenantId)
      return c.json({ error: "X-Tenant-Id header is required" }, 400);

    if (!deps.tenantSettingsRepository)
      throw new ServiceUnavailableError("Settings store not configured");

    const body = await c.req.json().catch(() => ({}));
    const parsed = settingsPatchSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid patch body", details: parsed.error.flatten() },
        422,
      );
    }

    const settings = await deps.tenantSettingsRepository.patch(
      tenantId,
      parsed.data,
    );
    return c.json({ tenantId, settings });
  });

  return route;
}
