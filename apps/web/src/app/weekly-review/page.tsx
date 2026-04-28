/**
 * Weekly Review — Phase 1 S5
 *
 * A structured founder-facing weekly cadence view summarising:
 *   - Content pipeline velocity: drafts produced vs approved this week
 *   - Signal ingestion activity: signals by type
 *   - Top approved pieces for distribution
 *   - Pending queue depth
 *   - Motion scores delta (this week vs prior)
 *
 * Data is fetched from the GrowthOS API.  Sections that have no data
 * degrade gracefully with empty-state prompts.
 */

import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { getMotionOverview, listApprovals } from "@/lib/api-client";

const DEV_TENANT_ID =
  process.env.GROWTHOS_DEV_TENANT_ID ?? "00000000-0000-0000-0001-000000000001";

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

const fmt = (d: Date) =>
  d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

const weekRange = () => {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 6);
  return { start, end };
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function WeeklyReviewPage() {
  const { start, end } = weekRange();

  // Fetch data in parallel — degrade gracefully on error.
  const [pendingDrafts, pendingBriefs, motionData] = await Promise.allSettled([
    listApprovals(DEV_TENANT_ID, { outputType: "blog_draft.v1", limit: 100 }),
    listApprovals(DEV_TENANT_ID, {
      outputType: "content_brief.v1",
      limit: 100,
    }),
    getMotionOverview(DEV_TENANT_ID, 2),
  ]);

  const drafts =
    pendingDrafts.status === "fulfilled" ? pendingDrafts.value.items : [];
  const briefs =
    pendingBriefs.status === "fulfilled" ? pendingBriefs.value.items : [];
  const motion = motionData.status === "fulfilled" ? motionData.value : null;

  // Items created this week.
  const thisWeekDrafts = drafts.filter((d) => new Date(d.enqueuedAt) >= start);
  const thisWeekBriefs = briefs.filter((b) => new Date(b.enqueuedAt) >= start);

  const primaryMotions = motion?.latestStack?.primaryMotions ?? [];
  const latestScores = motion?.latestScore?.scores ?? {};
  const priorScores = motion?.recentScores[1]?.scores ?? {};

  return (
    <div className="max-w-4xl">
      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">
            Weekly Review
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            {fmt(start)} — {fmt(end)} · Founder GTM cadence snapshot
          </p>
        </div>
        <span className="rounded-full bg-brand-50 px-3 py-1 text-xs font-medium text-brand-700 ring-1 ring-inset ring-brand-200">
          Week of {fmt(start)}
        </span>
      </div>

      {/* ── Summary stats row ────────────────────────────────────────── */}
      <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard
          label="Drafts this week"
          value={thisWeekDrafts.length}
          sub="pending approval"
        />
        <StatCard
          label="Briefs generated"
          value={thisWeekBriefs.length}
          sub="content briefs"
        />
        <StatCard
          label="Pending queue"
          value={drafts.length + briefs.length}
          sub="total items"
          highlight={drafts.length + briefs.length > 5}
        />
        <StatCard
          label="Active motions"
          value={
            primaryMotions.length +
            (motion?.latestStack?.secondaryMotions?.length ?? 0)
          }
          sub="primary + secondary"
        />
      </div>

      {/* ── Motion delta ─────────────────────────────────────────────── */}
      {Object.keys(latestScores).length > 0 && (
        <div className="mb-6 rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-sm font-semibold text-gray-900">
            Motion score delta
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {Object.entries(latestScores)
              .sort(([, a], [, b]) => b - a)
              .map(([key, score]) => {
                const prior = priorScores[key];
                const delta = prior !== undefined ? score - prior : null;
                const label = key
                  .replace(/_/g, " ")
                  .replace(/\b\w/g, (c) => c.toUpperCase());

                return (
                  <div key={key} className="rounded-lg bg-gray-50 px-3 py-3">
                    <p className="text-xs text-gray-500">{label}</p>
                    <div className="mt-1 flex items-end gap-2">
                      <span className="text-xl font-bold tabular-nums text-gray-900">
                        {Math.round(score * 100)}
                      </span>
                      {delta !== null && (
                        <span
                          className={`mb-0.5 text-xs font-medium ${
                            delta > 0
                              ? "text-green-600"
                              : delta < 0
                                ? "text-red-500"
                                : "text-gray-400"
                          }`}
                        >
                          {delta > 0 ? "+" : ""}
                          {Math.round(delta * 100)}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      )}

      {/* ── Content pipeline ─────────────────────────────────────────── */}
      <div className="mb-6 rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900">
            Content pipeline
          </h2>
          <a
            href="/approvals"
            className="text-xs font-medium text-brand-600 hover:text-brand-700"
          >
            Review all →
          </a>
        </div>

        {thisWeekDrafts.length === 0 ? (
          <EmptyState
            title="No drafts produced this week"
            description="Trigger the Intel Director worker to start the content pipeline."
          />
        ) : (
          <ul className="mt-4 divide-y divide-gray-100">
            {thisWeekDrafts.slice(0, 5).map((item) => {
              const payload = item.payload as {
                title?: string;
                word_count?: number;
              };
              return (
                <li
                  key={item.eventId}
                  className="flex items-center justify-between py-2.5 text-sm"
                >
                  <span className="font-medium text-gray-900">
                    {payload.title ?? "Untitled draft"}
                  </span>
                  <div className="flex items-center gap-3">
                    {payload.word_count && (
                      <span className="text-xs text-gray-400">
                        {payload.word_count.toLocaleString()} words
                      </span>
                    )}
                    <StatusBadge variant="pending" label="Pending" />
                  </div>
                </li>
              );
            })}
            {thisWeekDrafts.length > 5 && (
              <li className="py-2 text-xs text-gray-400">
                +{thisWeekDrafts.length - 5} more
              </li>
            )}
          </ul>
        )}
      </div>

      {/* ── Action checklist ─────────────────────────────────────────── */}
      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-sm font-semibold text-gray-900">
          Weekly founder checklist
        </h2>
        <ul className="space-y-2">
          {[
            {
              done: drafts.length === 0,
              label: "Review & approve all pending drafts",
              href: "/approvals",
            },
            {
              done: primaryMotions.length > 0,
              label: "Confirm motion stack is up to date",
              href: "/motion",
            },
            {
              done: false,
              label: "Ingest competitive signals from this week",
              href: "/signals",
            },
            {
              done: false,
              label: "Share approved content to distribution channels",
              href: "#",
            },
          ].map(({ done, label, href }) => (
            <li key={label} className="flex items-center gap-3">
              <span
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs ${
                  done
                    ? "bg-green-100 text-green-600"
                    : "bg-gray-100 text-gray-400"
                }`}
              >
                {done ? "✓" : "○"}
              </span>
              <a
                href={href}
                className={`text-sm ${
                  done
                    ? "text-gray-400 line-through"
                    : "text-gray-700 hover:text-brand-600"
                }`}
              >
                {label}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat card sub-component
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  sub,
  highlight = false,
}: {
  label: string;
  value: number;
  sub: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-4 ${
        highlight ? "border-amber-200 bg-amber-50" : "border-gray-200 bg-white"
      }`}
    >
      <p className="text-xs text-gray-500">{label}</p>
      <p
        className={`mt-1 text-3xl font-bold tabular-nums ${
          highlight ? "text-amber-700" : "text-gray-900"
        }`}
      >
        {value}
      </p>
      <p className="mt-0.5 text-xs text-gray-400">{sub}</p>
    </div>
  );
}
