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
  /** Onboarding / company profile (cookie-backed in dev). */
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

export async function readGrowthosSettings(): Promise<GrowthosSettings> {
  const jar = await cookies();
  const raw = jar.get(SETTINGS_COOKIE)?.value;
  if (!raw) return {};
  try {
    return JSON.parse(decodeURIComponent(raw)) as GrowthosSettings;
  } catch {
    return {};
  }
}

export async function writeGrowthosSettings(
  value: GrowthosSettings,
): Promise<void> {
  const jar = await cookies();
  jar.set(SETTINGS_COOKIE, encodeURIComponent(JSON.stringify(value)), {
    httpOnly: true,
    sameSite: "lax",
    maxAge: COOKIE_MAX_AGE_SECONDS,
    path: "/",
  });
}

export async function patchGrowthosSettings(
  patch: Partial<GrowthosSettings>,
): Promise<GrowthosSettings> {
  const prev = await readGrowthosSettings();
  const merged: GrowthosSettings = { ...prev, ...patch };
  await writeGrowthosSettings(merged);
  return merged;
}
