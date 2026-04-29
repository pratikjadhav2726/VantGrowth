/**
 * Motion Stack Overview — Phase 1 S5
 *
 * Fetches live motion scores + stack from GET /v1/motion.
 * Falls back to seed-data placeholders when no scores are recorded yet.
 */

import { MotionScoreForm } from "@/components/motion-score-form";
import { StatusBadge } from "@/components/status-badge";
import { type MotionOverview, getMotionOverview } from "@/lib/api-client";

const DEV_TENANT_ID =
  process.env.GROWTHOS_DEV_TENANT_ID ?? "00000000-0000-0000-0001-000000000001";

// ---------------------------------------------------------------------------
// Seed data placeholders (shown when no DB data exists)
// ---------------------------------------------------------------------------

const PLACEHOLDER_MOTIONS = [
  {
    key: "plg",
    label: "Product-Led Growth",
    score: 0.85,
    tier: "primary",
    description:
      "Strong trial-to-paid signal. High product virality coefficient.",
  },
  {
    key: "inbound_content",
    label: "Inbound Content",
    score: 0.71,
    tier: "secondary",
    description:
      "Early SEO traction. Founder voice content outperforms industry avg.",
  },
  {
    key: "outbound",
    label: "Outbound Sales",
    score: 0.62,
    tier: "observe",
    description: "Moderate response rates. Reply quality high but volume low.",
  },
  {
    key: "community",
    label: "Community-Led",
    score: 0.44,
    tier: "inactive",
    description: "Insufficient community density for this ICP segment.",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tierBadge = (tier: string) => {
  if (tier === "primary")
    return <StatusBadge variant="approved" label="Primary" />;
  if (tier === "secondary")
    return <StatusBadge variant="processing" label="Secondary" />;
  if (tier === "observe")
    return <StatusBadge variant="pending" label="Observe" />;
  return <StatusBadge variant="neutral" label="Inactive" />;
};

const barColor = (tier: string) => {
  if (tier === "primary") return "bg-brand-500";
  if (tier === "secondary") return "bg-blue-500";
  if (tier === "observe") return "bg-amber-500";
  return "bg-gray-300";
};

const motionLabel = (key: string) =>
  key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// ---------------------------------------------------------------------------
// Motion entries resolved from API data
// ---------------------------------------------------------------------------

interface MotionEntry {
  key: string;
  label: string;
  score: number;
  tier: string;
  description: string;
}

const resolveMotionEntries = (overview: MotionOverview): MotionEntry[] => {
  const { latestScore, latestStack } = overview;
  if (!latestScore) return PLACEHOLDER_MOTIONS;

  const allKeys = Object.keys(latestScore.scores);
  const primary = latestStack?.primaryMotions ?? [];
  const secondary = latestStack?.secondaryMotions ?? [];
  const observe = latestStack?.observeOnly ?? [];

  return allKeys
    .map((key) => {
      const score = latestScore.scores[key] ?? 0;
      const tier = primary.includes(key)
        ? "primary"
        : secondary.includes(key)
          ? "secondary"
          : observe.includes(key)
            ? "observe"
            : score > 0.5
              ? "secondary"
              : "inactive";
      return {
        key,
        label: motionLabel(key),
        score,
        tier,
        description:
          latestScore.rationale.find((r) =>
            r.toLowerCase().includes(key.replace(/_/g, " ").toLowerCase()),
          ) ?? "Scored automatically from GTM inputs.",
      };
    })
    .sort((a, b) => b.score - a.score);
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function MotionPage() {
  let overview: MotionOverview | null = null;
  let fetchError: string | null = null;

  try {
    overview = await getMotionOverview(DEV_TENANT_ID, 7);
  } catch (err) {
    fetchError =
      err instanceof Error ? err.message : "Failed to load motion data.";
  }

  const motions = overview
    ? resolveMotionEntries(overview)
    : PLACEHOLDER_MOTIONS;
  const isLiveData = !!overview?.latestScore;
  const latestScore = overview?.latestScore;
  const latestStack = overview?.latestStack;

  return (
    <div>
      {/* ── Page header ─────────────────────────────────────────────── */}
      <div className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">
            Motion Stack
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Your current GTM motion scores and active strategies.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isLiveData ? (
            <span className="rounded-full bg-green-50 px-3 py-1 text-xs font-medium text-green-700 ring-1 ring-inset ring-green-200">
              Live · {latestScore?.scorerVersion}
            </span>
          ) : (
            <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-200">
              Seed data — run scoring to populate
            </span>
          )}
        </div>
      </div>

      {/* ── Error state ─────────────────────────────────────────────── */}
      {fetchError && (
        <div className="mb-6 rounded-md bg-red-50 p-4 text-sm text-red-700">
          <strong>Warning:</strong> {fetchError} — showing seed data.
        </div>
      )}

      {/* ── Score grid ──────────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2">
        {motions.map((motion) => (
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
                  {tierBadge(motion.tier)}
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  {motion.description}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-3xl font-bold tabular-nums text-gray-900">
                  {Math.round(motion.score * 100)}
                </p>
                <p className="text-xs text-gray-400">/ 100</p>
              </div>
            </div>
            <div className="mt-4">
              <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
                <div
                  className={`h-full rounded-full transition-all ${barColor(motion.tier)}`}
                  style={{ width: `${motion.score * 100}%` }}
                />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* ── Stack configuration (live data only) ────────────────────── */}
      {latestStack && (
        <div className="mt-6 rounded-lg border border-gray-200 bg-white p-6">
          <h3 className="text-sm font-semibold text-gray-900">
            Stack configuration
          </h3>
          <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div>
              <dt className="text-xs text-gray-500">Primary</dt>
              <dd className="mt-0.5 text-sm font-medium text-gray-900">
                {latestStack.primaryMotions.map(motionLabel).join(", ") || "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">Secondary</dt>
              <dd className="mt-0.5 text-sm font-medium text-gray-900">
                {latestStack.secondaryMotions.map(motionLabel).join(", ") ||
                  "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">Observe</dt>
              <dd className="mt-0.5 text-sm font-medium text-gray-900">
                {latestStack.observeOnly.map(motionLabel).join(", ") || "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">Version</dt>
              <dd className="mt-0.5 text-sm font-medium text-gray-900">
                v{latestStack.version}
              </dd>
            </div>
          </dl>
        </div>
      )}

      {/* ── Score history sparklines ─────────────────────────────────── */}
      {overview && overview.recentScores.length > 1 && (
        <div className="mt-6 rounded-lg border border-gray-200 bg-white p-6">
          <h3 className="mb-4 text-sm font-semibold text-gray-900">
            Score history ({overview.recentScores.length} runs)
          </h3>
          <div className="space-y-3">
            {overview.recentScores.slice(0, 5).map((row) => (
              <div key={row.id} className="flex items-center gap-4 text-xs">
                <span className="w-36 shrink-0 text-gray-500">
                  {new Date(row.scoredAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                <div className="flex flex-1 flex-wrap gap-2">
                  {Object.entries(row.scores)
                    .sort(([, a], [, b]) => b - a)
                    .slice(0, 3)
                    .map(([key, score]) => (
                      <span
                        key={key}
                        className="rounded-full bg-gray-100 px-2 py-0.5 text-gray-700"
                      >
                        {motionLabel(key)}: {Math.round(score * 100)}
                      </span>
                    ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Motion scoring form ───────────────────────────────────────── */}
      <div className="mt-8">
        <h3 className="text-sm font-semibold text-gray-900">
          Run or refresh motion scoring
        </h3>
        <p className="mt-1 text-sm text-gray-500">
          Adjust GTM inputs and persist a new{" "}
          <code className="rounded bg-gray-100 px-1">motion_scores</code> row
          via{" "}
          <code className="rounded bg-gray-100 px-1">
            POST /v1/motions/score
          </code>
          . Requires API and database (same tenant as this page).
        </p>
        <MotionScoreForm tenantId={DEV_TENANT_ID} />
      </div>

      {/* ── Scorer metadata (seed data) ─────────────────────────────── */}
      {!isLiveData && (
        <div className="mt-6 rounded-lg border border-gray-200 bg-white p-6">
          <h3 className="text-sm font-semibold text-gray-900">No scores yet</h3>
          <p className="mt-1 text-sm text-gray-500">
            Use the form above, or call the API directly:
          </p>
          <pre className="mt-3 overflow-x-auto rounded-md bg-gray-50 p-3 text-xs text-gray-700">
            {`curl -X POST http://localhost:3000/v1/motions/score \\
  -H "Content-Type: application/json" \\
  -d '{"tenantId":"${DEV_TENANT_ID}","productComplexity":0.7,...}'`}
          </pre>
        </div>
      )}
    </div>
  );
}
