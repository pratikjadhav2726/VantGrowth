/**
 * Onboarding wizard — Phase 1 / S6
 *
 * 4-step guided setup for new founders:
 *   1. Company basics (name, website, ICP, headcount, ARR)
 *   2. Brand context (positioning, proof points, tone)
 *   3. Motion score reveal (auto-scores from inputs, shows stack)
 *   4. Complete (next actions, links)
 *
 * State is stored in a signed cookie so each step is bookmarkable.
 */

import { getMotionOverview, postMotionScore } from "@/lib/api-client";
import {
  completeOnboarding,
  getOnboardingState,
  resetOnboarding,
  submitBrandStep,
  submitCompanyStep,
} from "./actions";
import { BrandStepForm } from "./brand-step-form";
import { CompanyStepForm } from "./company-step-form";

const DEV_TENANT_ID =
  process.env.GROWTHOS_DEV_TENANT_ID ?? "00000000-0000-0000-0001-000000000001";

const STEPS = [
  { n: 1, label: "Company" },
  { n: 2, label: "Brand" },
  { n: 3, label: "Score" },
  { n: 4, label: "Done" },
];

function StepIndicator({ current }: { current: number }) {
  return (
    <nav aria-label="Progress" className="mb-10">
      <ol className="flex items-center gap-0">
        {STEPS.map((s, i) => {
          const done = s.n < current;
          const active = s.n === current;
          return (
            <li key={s.n} className="flex items-center">
              <div className="flex flex-col items-center">
                <div
                  className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold border-2 transition-colors ${
                    done
                      ? "border-brand-600 bg-brand-600 text-white"
                      : active
                        ? "border-brand-600 bg-white text-brand-600"
                        : "border-gray-200 bg-white text-gray-400"
                  }`}
                >
                  {done ? (
                    <svg
                      className="h-4 w-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2.5}
                    >
                      <title>Done</title>
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  ) : (
                    s.n
                  )}
                </div>
                <span
                  className={`mt-1.5 text-xs font-medium ${active ? "text-brand-600" : done ? "text-gray-500" : "text-gray-400"}`}
                >
                  {s.label}
                </span>
              </div>
              {i < STEPS.length - 1 && (
                <div
                  className={`mx-3 mb-5 h-0.5 w-16 flex-1 transition-colors ${done ? "bg-brand-600" : "bg-gray-200"}`}
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — Company basics
// ---------------------------------------------------------------------------

function CompanyStep({ defaults }: { defaults: Record<string, string> }) {
  return (
    <CompanyStepForm defaults={defaults} submitAction={submitCompanyStep} />
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Brand context
// ---------------------------------------------------------------------------

function BrandStep({ defaults }: { defaults: Record<string, string> }) {
  return <BrandStepForm defaults={defaults} submitAction={submitBrandStep} />;
}

// ---------------------------------------------------------------------------
// Step 3 — Motion score reveal
// ---------------------------------------------------------------------------

function arrToGrowthRate(arr: string): number {
  if (arr === "pre-revenue") return 0.2;
  if (arr === "0-500k") return 0.4;
  if (arr === "500k-2m") return 0.6;
  if (arr === "2m-10m") return 0.75;
  return 0.85;
}

function headcountToTeamSize(h: string): number {
  if (h === "1-10") return 0.2;
  if (h === "11-50") return 0.45;
  if (h === "51-200") return 0.65;
  if (h === "201-500") return 0.8;
  return 0.9;
}

async function ScoreRevealStep({
  companyName,
  arr,
  headcount,
}: {
  companyName: string | undefined;
  arr: string | undefined;
  headcount: string | undefined;
}) {
  const growthRate = arrToGrowthRate(arr ?? "500k-2m");
  const teamSize = headcountToTeamSize(headcount ?? "11-50");

  let motionData: Awaited<ReturnType<typeof getMotionOverview>> | null = null;
  let scoreError: string | null = null;

  try {
    // Auto-score with derived inputs — map company profile to scoring dimensions
    await postMotionScore(DEV_TENANT_ID, {
      productComplexity: 0.5,
      trialability: 0.6,
      acvBand: growthRate,
      salesCycleWeeks: 6,
      founderContentCapacity: teamSize,
      categorySearchDemand: 0.65,
      communityDensity: 0.5,
      telemetryReadiness: 0.55,
      budgetReadiness: growthRate * 0.9,
    });
    motionData = await getMotionOverview(DEV_TENANT_ID);
  } catch {
    scoreError = "Could not connect to API — showing sample results.";
  }

  const primaryMotions = motionData?.latestStack?.primaryMotions ?? [
    "inbound_content",
    "community_led",
  ];
  const secondaryMotions = motionData?.latestStack?.secondaryMotions ?? [
    "partner_referral",
  ];

  const motionLabel: Record<string, string> = {
    inbound_content: "Inbound Content",
    community_led: "Community-Led Growth",
    partner_referral: "Partner Referral",
    product_led: "Product-Led Growth",
    outbound_sales: "Outbound Sales",
    event_marketing: "Event Marketing",
    analyst_relations: "Analyst Relations",
    customer_advocacy: "Customer Advocacy",
  };

  return (
    <div className="space-y-6">
      {scoreError && (
        <div className="rounded-md bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-700">
          {scoreError}
        </div>
      )}

      <div>
        <h3 className="text-sm font-medium text-gray-500 mb-3">
          Recommended motion stack for {companyName ?? "your company"}
        </h3>

        <div className="space-y-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-brand-600 mb-2">
              Primary motions — focus here
            </p>
            <div className="flex flex-wrap gap-2">
              {primaryMotions.map((m) => (
                <span
                  key={m}
                  className="inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-700 ring-1 ring-brand-200"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />
                  {motionLabel[m] ?? m}
                </span>
              ))}
            </div>
          </div>

          {secondaryMotions.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">
                Secondary motions — invest selectively
              </p>
              <div className="flex flex-wrap gap-2">
                {secondaryMotions.map((m) => (
                  <span
                    key={m}
                    className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-3 py-1.5 text-sm font-medium text-gray-600"
                  >
                    {motionLabel[m] ?? m}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
        <p className="text-xs text-gray-500 leading-relaxed">
          GrowthOS will produce content and intel briefs aligned to your primary
          motions. You can re-score anytime from the{" "}
          <span className="font-medium text-gray-700">Motion stack</span> page.
        </p>
      </div>

      <form action={completeOnboarding}>
        <button
          type="submit"
          className="w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 transition-colors"
        >
          Finish setup →
        </button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 4 — Complete
// ---------------------------------------------------------------------------

function CompleteStep({ companyName }: { companyName: string | undefined }) {
  const actions = [
    {
      href: "/approvals",
      icon: "✓",
      title: "Review your approval queue",
      desc: "AI-generated content lands here for your review before publishing.",
    },
    {
      href: "/motion",
      icon: "◆",
      title: "Explore your motion stack",
      desc: "See which GTM motions are prioritised and re-score anytime.",
    },
    {
      href: "/weekly-review",
      icon: "▲",
      title: "Weekly operating review",
      desc: "Pipeline velocity, content output, and approval stats in one view.",
    },
  ];

  return (
    <div className="space-y-6">
      <div className="rounded-xl bg-gradient-to-br from-brand-50 to-white border border-brand-100 p-6 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-brand-100 text-2xl">
          🎉
        </div>
        <h3 className="text-lg font-semibold text-gray-900">
          {companyName ?? "Your company"} is ready
        </h3>
        <p className="mt-1 text-sm text-gray-500">
          GrowthOS agents are running. Your first content briefs will appear in
          the approval queue within 24 hours.
        </p>
      </div>

      <div className="space-y-2">
        {actions.map((a) => (
          <a
            key={a.href}
            href={a.href}
            className="flex items-start gap-3 rounded-lg border border-gray-200 bg-white p-4 hover:border-brand-300 hover:bg-brand-50 transition-colors group"
          >
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand-100 text-brand-700 text-sm font-bold group-hover:bg-brand-200 transition-colors">
              {a.icon}
            </span>
            <div>
              <p className="text-sm font-medium text-gray-900">{a.title}</p>
              <p className="text-xs text-gray-500 mt-0.5">{a.desc}</p>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page router
// ---------------------------------------------------------------------------

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ step?: string; error?: string }>;
}) {
  const { step: stepParam, error: errorParam } = await searchParams;
  const state = await getOnboardingState();
  const step = Math.max(1, Math.min(4, Number(stepParam ?? state.step ?? 1)));
  const errorMessage = errorParam?.trim() ? errorParam : undefined;

  const stepTitles = [
    "Tell us about your company",
    "Set your brand context",
    "Your recommended motion stack",
    "You're all set",
  ];
  const stepSubtitles = [
    "This helps GrowthOS understand your GTM context and score your motion stack.",
    "Your brand voice guides every piece of content your agents produce.",
    "Based on your inputs, here's what GrowthOS recommends focusing on.",
    "GrowthOS is configured and agents are standing by.",
  ];

  return (
    <div className="mx-auto max-w-xl py-12 px-4">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">
          GrowthOS setup
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Takes about 5 minutes. You can always update these settings later.
        </p>
      </div>

      {errorMessage && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {errorMessage}
        </div>
      )}

      <StepIndicator current={step} />

      <div className="rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-gray-900">
            {stepTitles[step - 1]}
          </h2>
          <p className="mt-1 text-sm text-gray-500">
            {stepSubtitles[step - 1]}
          </p>
        </div>

        {step === 1 && (
          <CompanyStep
            defaults={{
              companyName: state.companyName ?? "",
              website: state.website ?? "",
              icpDescription: state.icpDescription ?? "",
              headcount: state.headcount ?? "11-50",
              arr: state.arr ?? "500k-2m",
            }}
          />
        )}

        {step === 2 && (
          <BrandStep
            defaults={{
              positioning: state.positioning ?? "",
              wordsToAvoid: state.wordsToAvoid ?? "",
              proof1: state.proofPoints?.[0] ?? "",
              proof2: state.proofPoints?.[1] ?? "",
              proof3: state.proofPoints?.[2] ?? "",
              tone: state.tone ?? "founder-voice",
            }}
          />
        )}

        {step === 3 && (
          <ScoreRevealStep
            companyName={state.companyName}
            arr={state.arr}
            headcount={state.headcount}
          />
        )}

        {step === 4 && <CompleteStep companyName={state.companyName} />}
      </div>

      {step > 1 && step < 4 && (
        <div className="mt-4 text-center">
          <a
            href={`/onboarding?step=${step - 1}`}
            className="text-sm text-gray-400 hover:text-gray-600 transition-colors"
          >
            ← Back
          </a>
        </div>
      )}
    </div>
  );
}
