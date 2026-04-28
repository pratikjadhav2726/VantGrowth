/**
 * Motion Stack Overview — Phase 1 S5
 *
 * Displays the current GTM motion scores and active motion stack for the
 * dev tenant.  Data is fetched server-side from the GrowthOS API.
 *
 * In Phase 2 this page will poll real motion_scores + motion_stack data
 * via authenticated API endpoints.  For now it displays a static
 * representation with a live signal ingest demo form.
 */

import { StatusBadge } from "@/components/status-badge";

// ---------------------------------------------------------------------------
// Motion score data (placeholder until GET /v1/motion endpoint is added)
// ---------------------------------------------------------------------------

const PLACEHOLDER_SCORES = [
  {
    key: "product-led-growth",
    label: "Product-Led Growth",
    score: 0.85,
    active: "primary",
    description:
      "Strong trial-to-paid signal. High product virality coefficient.",
    color: "bg-brand-500",
  },
  {
    key: "content-marketing",
    label: "Content Marketing",
    score: 0.71,
    active: "secondary",
    description:
      "Early SEO traction. Founder voice content outperforms industry avg.",
    color: "bg-blue-500",
  },
  {
    key: "outbound-sales",
    label: "Outbound Sales",
    score: 0.62,
    active: "observe",
    description: "Moderate response rates. Reply quality high but volume low.",
    color: "bg-amber-500",
  },
  {
    key: "community-led",
    label: "Community-Led",
    score: 0.44,
    active: "inactive",
    description: "Insufficient community density for this ICP segment.",
    color: "bg-gray-400",
  },
] as const;

const statusForActive = (
  active: (typeof PLACEHOLDER_SCORES)[number]["active"],
): "approved" | "processing" | "pending" | "neutral" => {
  if (active === "primary") return "approved";
  if (active === "secondary") return "processing";
  if (active === "observe") return "pending";
  return "neutral";
};

const labelForActive = (
  active: (typeof PLACEHOLDER_SCORES)[number]["active"],
) => {
  if (active === "primary") return "Primary";
  if (active === "secondary") return "Secondary";
  if (active === "observe") return "Observe";
  return "Inactive";
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function MotionPage() {
  return (
    <div>
      {/* ── Page header ─────────────────────────────────────────────── */}
      <div className="mb-8">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-gray-900">
              Motion Stack
            </h1>
            <p className="mt-1 text-sm text-gray-500">
              Your current GTM motion scores and active strategies. Scores are
              updated after each intel brief cycle.
            </p>
          </div>
          <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700 ring-1 ring-inset ring-blue-200">
            v1.0.0-seed · Updated Apr 28
          </span>
        </div>
      </div>

      {/* ── Score grid ──────────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2">
        {PLACEHOLDER_SCORES.map((motion) => (
          <div
            key={motion.key}
            className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-gray-900">
                    {motion.label}
                  </h2>
                  <StatusBadge
                    variant={statusForActive(motion.active)}
                    label={labelForActive(motion.active)}
                  />
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  {motion.description}
                </p>
              </div>

              {/* Score display */}
              <div className="shrink-0 text-right">
                <p className="text-3xl font-bold tabular-nums text-gray-900">
                  {Math.round(motion.score * 100)}
                </p>
                <p className="text-xs text-gray-400">/ 100</p>
              </div>
            </div>

            {/* Score bar */}
            <div className="mt-4">
              <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
                <div
                  className={`h-full rounded-full transition-all ${motion.color}`}
                  style={{ width: `${motion.score * 100}%` }}
                />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* ── Scorer metadata ─────────────────────────────────────────── */}
      <div className="mt-8 rounded-lg border border-gray-200 bg-white p-6">
        <h3 className="text-sm font-semibold text-gray-900">Scorer details</h3>
        <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[
            { label: "Scorer version", value: "motion_scorer.v1" },
            { label: "Primary motion", value: "Product-Led Growth" },
            { label: "Active motions", value: "3" },
            { label: "Confidence", value: "87%" },
          ].map(({ label, value }) => (
            <div key={label}>
              <dt className="text-xs text-gray-500">{label}</dt>
              <dd className="mt-0.5 text-sm font-medium text-gray-900">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      {/* ── Recent scoring inputs ────────────────────────────────────── */}
      <div className="mt-6 rounded-lg border border-gray-200 bg-white p-6">
        <h3 className="mb-4 text-sm font-semibold text-gray-900">
          Scoring inputs (last run)
        </h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {[
            { label: "Product complexity", value: "0.70" },
            { label: "Trialability", value: "0.60" },
            { label: "Founder content cap.", value: "0.80" },
            { label: "Community density", value: "0.70" },
            { label: "Sales cycle", value: "6 wks" },
          ].map(({ label, value }) => (
            <div key={label} className="rounded-md bg-gray-50 px-3 py-2.5">
              <p className="text-xs text-gray-500">{label}</p>
              <p className="mt-0.5 text-sm font-semibold text-gray-900">
                {value}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
