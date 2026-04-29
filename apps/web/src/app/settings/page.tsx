/**
 * Settings — Phase 1 / S6
 *
 * Surfaces three categories of settings:
 *   1. Connections — API keys and external integrations
 *   2. Brand assets — logo, colors, voice guide
 *   3. Policy preferences — auto-approve threshold, content types
 *
 * Values persist in cookies for dev; in production these are Vault secrets
 * and database rows scoped to the tenant.
 */

import {
  type GrowthosSettings,
  readGrowthosSettings,
  writeGrowthosSettings,
} from "@/lib/settings-cookie";
import { revalidatePath } from "next/cache";

async function saveSettings(formData: FormData) {
  "use server";
  const current = await readGrowthosSettings();
  const newApiKey = (formData.get("openaiApiKey") as string | null)?.trim();
  const newLogoUrl = (formData.get("logoUrl") as string | null)?.trim();
  const newPrimaryColor =
    (formData.get("primaryColor") as string | null) ?? undefined;
  const newDigestEmail = (formData.get("digestEmail") as string | null)?.trim();

  const next: GrowthosSettings = {
    ...current,
    autoApproveThreshold:
      (formData.get("autoApproveThreshold") as string | null) ?? "0",
    enableBlogDraft: formData.get("enableBlogDraft") === "on",
    enableContentBrief: formData.get("enableContentBrief") === "on",
    enableIntelBrief: formData.get("enableIntelBrief") === "on",
  };

  if (newApiKey) {
    next.openaiApiKey = newApiKey;
  } else if (current.openaiApiKey) {
    next.openaiApiKey = current.openaiApiKey;
  }

  if (newLogoUrl) {
    next.logoUrl = newLogoUrl;
  }

  if (newPrimaryColor) {
    next.primaryColor = newPrimaryColor;
  }

  if (newDigestEmail) {
    next.digestEmail = newDigestEmail;
  }

  await writeGrowthosSettings(next);
  revalidatePath("/settings");
}

function SectionHeader({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="mb-5">
      <h2 className="text-base font-semibold text-gray-900">{title}</h2>
      <p className="mt-0.5 text-sm text-gray-500">{desc}</p>
    </div>
  );
}

function FieldRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-sm font-medium text-gray-700">{label}</p>
      {children}
      {hint && <p className="text-xs text-gray-400">{hint}</p>}
    </div>
  );
}

function Toggle({
  name,
  label,
  defaultChecked,
}: {
  name: string;
  label: string;
  defaultChecked?: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-gray-200 bg-white px-4 py-3 hover:border-gray-300 transition-colors">
      <span className="text-sm font-medium text-gray-700">{label}</span>
      <input
        type="checkbox"
        name={name}
        value="on"
        defaultChecked={defaultChecked}
        className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
      />
    </label>
  );
}

export default async function SettingsPage() {
  const settings = await readGrowthosSettings();

  const maskedKey = settings.openaiApiKey
    ? `sk-••••••••${settings.openaiApiKey.slice(-4)}`
    : "";

  return (
    <div className="mx-auto max-w-2xl py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">
          Settings
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Configure integrations, brand context, and content preferences.
        </p>
      </div>

      <form action={saveSettings} className="space-y-10">
        {/* ── Connections ──────────────────────────────────────────────── */}
        <section className="rounded-xl border border-gray-200 bg-white p-6">
          <SectionHeader
            title="Connections"
            desc="API keys and external service credentials."
          />
          <div className="space-y-5">
            <FieldRow
              label="OpenAI API key"
              hint="Used by all LLM-backed agents. Stored encrypted at rest."
            >
              <input
                name="openaiApiKey"
                type="password"
                placeholder={maskedKey || "sk-..."}
                autoComplete="off"
                className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
              />
            </FieldRow>

            <FieldRow
              label="Digest recipient email"
              hint="Where to send weekly founder digests. Requires Postal to be configured."
            >
              <input
                name="digestEmail"
                type="email"
                defaultValue={settings.digestEmail ?? ""}
                placeholder="founder@yourcompany.com"
                className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
              />
            </FieldRow>
          </div>
        </section>

        {/* ── Company profile (from onboarding) ───────────────────────── */}
        {(settings.companyName || settings.onboardingCompletedAt) && (
          <section className="rounded-xl border border-gray-200 bg-white p-6">
            <SectionHeader
              title="Company profile"
              desc="Synced from onboarding. Re-run the wizard anytime from Setup."
            />
            <dl className="space-y-3 text-sm">
              {settings.companyName && (
                <div>
                  <dt className="text-xs font-medium text-gray-500">Company</dt>
                  <dd className="text-gray-900">{settings.companyName}</dd>
                </div>
              )}
              {settings.icpDescription && (
                <div>
                  <dt className="text-xs font-medium text-gray-500">ICP</dt>
                  <dd className="text-gray-700 leading-relaxed">
                    {settings.icpDescription}
                  </dd>
                </div>
              )}
              {settings.positioning && (
                <div>
                  <dt className="text-xs font-medium text-gray-500">
                    Positioning
                  </dt>
                  <dd className="text-gray-700 leading-relaxed">
                    {settings.positioning}
                  </dd>
                </div>
              )}
            </dl>
          </section>
        )}

        {/* ── Brand assets ─────────────────────────────────────────────── */}
        <section className="rounded-xl border border-gray-200 bg-white p-6">
          <SectionHeader
            title="Brand assets"
            desc="Visual identity used in generated content previews."
          />
          <div className="space-y-5">
            <FieldRow label="Logo URL">
              <input
                name="logoUrl"
                type="url"
                defaultValue={settings.logoUrl ?? ""}
                placeholder="https://cdn.yourcompany.com/logo.svg"
                className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
              />
            </FieldRow>

            <FieldRow
              label="Primary brand color"
              hint="Used in content previews."
            >
              <div className="flex items-center gap-3">
                <input
                  name="primaryColor"
                  type="color"
                  defaultValue={settings.primaryColor ?? "#6366f1"}
                  className="h-10 w-16 cursor-pointer rounded-md border border-gray-300 p-0.5"
                />
                <input
                  type="text"
                  readOnly
                  value={settings.primaryColor ?? "#6366f1"}
                  className="w-28 rounded-lg border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-500 font-mono"
                />
              </div>
            </FieldRow>
          </div>
        </section>

        {/* ── Policy preferences ───────────────────────────────────────── */}
        <section className="rounded-xl border border-gray-200 bg-white p-6">
          <SectionHeader
            title="Policy preferences"
            desc="Control which content types agents produce and approval thresholds."
          />
          <div className="space-y-4">
            <div className="space-y-2">
              <p className="text-sm font-medium text-gray-700 mb-2">
                Enable content types
              </p>
              <Toggle
                name="enableBlogDraft"
                label="Blog drafts"
                defaultChecked={settings.enableBlogDraft ?? true}
              />
              <Toggle
                name="enableContentBrief"
                label="Content briefs"
                defaultChecked={settings.enableContentBrief ?? true}
              />
              <Toggle
                name="enableIntelBrief"
                label="Intel briefs"
                defaultChecked={settings.enableIntelBrief ?? true}
              />
            </div>

            <FieldRow
              label="Auto-approve confidence threshold"
              hint="Items with confidence score above this value skip the queue. 0 = always require review."
            >
              <div className="flex items-center gap-4">
                <input
                  name="autoApproveThreshold"
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  defaultValue={settings.autoApproveThreshold ?? "0"}
                  className="flex-1 accent-brand-600"
                />
                <span className="w-10 text-right text-sm font-medium text-gray-700">
                  {settings.autoApproveThreshold
                    ? `${Math.round(Number(settings.autoApproveThreshold) * 100)}%`
                    : "Off"}
                </span>
              </div>
            </FieldRow>
          </div>
        </section>

        <div className="flex items-center justify-end gap-3">
          <a
            href="/"
            className="rounded-lg px-4 py-2.5 text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors"
          >
            Cancel
          </a>
          <button
            type="submit"
            className="rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 transition-colors"
          >
            Save settings
          </button>
        </div>
      </form>
    </div>
  );
}
