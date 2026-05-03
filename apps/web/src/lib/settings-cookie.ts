import { cookies } from "next/headers";

export const SETTINGS_COOKIE = "growthos_settings";

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 90;

export type GrowthosSettings = {
  openaiApiKey?: string;
  logoUrl?: string;
  primaryColor?: string;
  autoApproveThreshold?: string;
  enableBlogDraft?: boolean;
  enableContentBrief?: boolean;
  enableIntelBrief?: boolean;
  digestEmail?: string;
  /** Onboarding / company profile. */
  companyName?: string;
  website?: string;
  icpDescription?: string;
  headcount?: string;
  arr?: string;
  positioning?: string;
  proofPoints?: string[];
  tone?: string;
  wordsToAvoid?: string;
  onboardingCompletedAt?: string;
};

// ---------------------------------------------------------------------------
// Internal helpers — Postgres-backed via API
// ---------------------------------------------------------------------------

const API_BASE =
  process.env.GROWTHOS_API_BASE_URL ??
  process.env.NEXT_PUBLIC_GROWTHOS_API_BASE_URL;
const DEV_TENANT_ID =
  process.env.GROWTHOS_DEV_TENANT_ID ?? "00000000-0000-0000-0001-000000000001";
const SERVICE_TOKEN = process.env.GROWTHOS_API_SERVICE_TOKEN;

/** Returns true when the Postgres-backed settings API is reachable. */
const apiConfigured = () => Boolean(API_BASE && DEV_TENANT_ID);

async function fetchSettingsFromApi(): Promise<GrowthosSettings> {
  const res = await fetch(`${API_BASE}/v1/settings`, {
    headers: { "X-Tenant-Id": DEV_TENANT_ID, "Content-Type": "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`GET /v1/settings failed: ${res.status}`);
  const json = (await res.json()) as { settings: Record<string, unknown> };
  return json.settings as GrowthosSettings;
}

async function patchSettingsViaApi(
  patch: Partial<GrowthosSettings>,
): Promise<void> {
  if (!SERVICE_TOKEN) return; // write path requires service token
  const res = await fetch(`${API_BASE}/v1/settings`, {
    method: "PATCH",
    headers: {
      "X-Tenant-Id": DEV_TENANT_ID,
      "Content-Type": "application/json",
      Authorization: `Bearer ${SERVICE_TOKEN}`,
    },
    body: JSON.stringify(patch),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`PATCH /v1/settings failed: ${res.status}`);
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

async function readFromCookie(): Promise<GrowthosSettings> {
  const jar = await cookies();
  const raw = jar.get(SETTINGS_COOKIE)?.value;
  if (!raw) return {};
  try {
    return JSON.parse(decodeURIComponent(raw)) as GrowthosSettings;
  } catch {
    return {};
  }
}

async function writeToCookie(value: GrowthosSettings): Promise<void> {
  const jar = await cookies();
  jar.set(SETTINGS_COOKIE, encodeURIComponent(JSON.stringify(value)), {
    httpOnly: true,
    sameSite: "lax",
    maxAge: COOKIE_MAX_AGE_SECONDS,
    path: "/",
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reads settings. When the API is configured (prod), fetches from Postgres
 * and merges with cookie (cookie values for keys absent in DB are preserved).
 * Falls back to cookie-only in dev when no API base URL is set.
 */
export async function readGrowthosSettings(): Promise<GrowthosSettings> {
  const cookieSettings = await readFromCookie();
  if (!apiConfigured()) return cookieSettings;

  try {
    const dbSettings = await fetchSettingsFromApi();
    // DB is source of truth; cookie supplements keys not yet migrated.
    return { ...cookieSettings, ...dbSettings };
  } catch {
    return cookieSettings;
  }
}

/**
 * Writes settings. When the API is configured (prod), persists to Postgres
 * and keeps the cookie in sync as a local cache. In dev, cookie-only.
 */
export async function writeGrowthosSettings(
  value: GrowthosSettings,
): Promise<void> {
  await writeToCookie(value);
  if (apiConfigured()) {
    try {
      await patchSettingsViaApi(value);
    } catch {
      // Swallow — cookie write already succeeded; DB write retried on next PATCH.
    }
  }
}

/**
 * Shallow-merges `patch` into existing settings and persists.
 */
export async function patchGrowthosSettings(
  patch: Partial<GrowthosSettings>,
): Promise<GrowthosSettings> {
  const prev = await readGrowthosSettings();
  const merged: GrowthosSettings = { ...prev, ...patch };
  await writeGrowthosSettings(merged);
  return merged;
}
