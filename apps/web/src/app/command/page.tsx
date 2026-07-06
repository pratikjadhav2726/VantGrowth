/**
 * Command Center — the one-page operational view.
 *
 * LIVE: the Approval Queue (from /v1/approvals) + the agent roster (real workers).
 * DEMO SCENARIO (labeled): signal feed, next-best-actions, channel health,
 * pipeline counts — representing the view once ingestion + dispatch are wired.
 */

import { StatusBadge } from "@/components/status-badge";
import { AGENTS, STATUS_META } from "@/lib/agent-catalog";
import { getMotionOverview, listApprovals } from "@/lib/api-client";
import { TIER_META, motionDisplay, type MotionTier } from "@/lib/motion-catalog";
import {
  AGENT_RUNTIME,
  CHANNELS,
  CHANNEL_STATE_META,
  NEXT_BEST_ACTIONS,
  PIPELINE_STAGES,
  PRIORITY_LABEL,
  PRIORITY_META,
  SCENARIO_KPIS,
  SIGNAL_FEED,
} from "@/lib/command-center-demo";
import Link from "next/link";

const DEV_TENANT_ID =
  process.env.GROWTHOS_DEV_TENANT_ID ?? "00000000-0000-0000-0001-000000000001";

interface ApprovalItem {
  eventId: string;
  outputType: string;
  payload: { title?: string; meta_description?: string };
}

const TYPE_LABEL: Record<string, string> = {
  "blog_draft.v1": "Blog",
  "content_brief.v1": "Brief",
  "intel_brief.v1": "Intel",
};

async function loadApprovals(): Promise<ApprovalItem[]> {
  try {
    const types = ["intel_brief.v1", "blog_draft.v1", "content_brief.v1"];
    const results = await Promise.all(
      types.map((t) =>
        listApprovals(DEV_TENANT_ID, { outputType: t, limit: 5 }).catch(() => ({
          items: [],
        })),
      ),
    );
    return results.flatMap((r) => r.items as ApprovalItem[]);
  } catch {
    return [];
  }
}

interface ScoredMotion {
  label: string;
  score: number;
  tier: MotionTier;
}

async function loadMotions(): Promise<{ motions: ScoredMotion[]; rationale: string[] }> {
  try {
    const overview = await getMotionOverview(DEV_TENANT_ID);
    const scores = overview.latestScore?.scores ?? {};
    const stack = overview.latestStack;
    const tierOf = (label: string): MotionTier => {
      if (stack?.primaryMotions?.includes(label)) return "Primary";
      if (stack?.secondaryMotions?.includes(label)) return "Secondary";
      if (stack?.observeOnly?.includes(label)) return "Observe";
      if (stack?.deactivated?.includes(label)) return "Off";
      return "Observe";
    };
    const motions = Object.entries(scores)
      .map(([label, score]) => ({ label, score: Number(score), tier: tierOf(label) }))
      .sort((a, b) => b.score - a.score);
    return { motions, rationale: overview.latestScore?.rationale ?? [] };
  } catch {
    return { motions: [], rationale: [] };
  }
}

export default async function CommandCenterPage() {
  const [approvals, motionData] = await Promise.all([loadApprovals(), loadMotions()]);
  const roster = AGENTS.filter((a) => a.category !== "Infrastructure");

  return (
    <div className="space-y-4">
      {/* ── Header + KPIs ────────────────────────────────────────────── */}
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-gray-900">
              Insurance company · Command Center
            </h1>
            <p className="text-sm text-gray-500">
              Motion:{" "}
              <span className="font-medium text-gray-700">
                {SCENARIO_KPIS.motion}
              </span>
            </p>
          </div>
          <div className="flex items-center gap-3 text-xs text-gray-500">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-green-500" /> Live data
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-gray-300" /> Demo scenario
            </span>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Kpi label="Signals today" value={SCENARIO_KPIS.signalsToday} scenario />
          <Kpi label="Next-best-actions" value={SCENARIO_KPIS.nbasPending} scenario />
          <Kpi label="Approvals" value={approvals.length} live />
          <Kpi label="Warm accounts" value={SCENARIO_KPIS.warmAccounts} scenario />
          <Kpi label="Pipeline" value={SCENARIO_KPIS.pipelineValue} scenario />
        </div>
      </div>

      {/* ── Main 3-column grid ───────────────────────────────────────── */}
      <div className="grid grid-cols-12 gap-4">
        {/* LEFT — Agent roster / heartbeats */}
        <div className="col-span-12 lg:col-span-3">
          <Panel title="Agent Roster" subtitle="heartbeats">
            <ul className="space-y-1.5">
              {roster.map((a) => {
                const meta = STATUS_META[a.status];
                const rt = AGENT_RUNTIME[a.id];
                return (
                  <li key={a.id}>
                    <Link
                      href={`/agents/${a.id}`}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-gray-50"
                    >
                      <span className={`h-2 w-2 shrink-0 rounded-full ${meta.dot}`} />
                      <span className="flex-1 truncate text-gray-700">{a.name}</span>
                      <span className="font-mono text-[10px] text-gray-400">
                        {rt?.lastRun ? `✓${rt.lastRun}` : rt?.queue ?? meta.label}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
            <Link
              href="/agents"
              className="mt-3 block text-xs font-medium text-brand-600 hover:underline"
            >
              Open full roster →
            </Link>
          </Panel>
        </div>

        {/* CENTER — Signal feed + Next-best-action */}
        <div className="col-span-12 space-y-4 lg:col-span-6">
          <Panel title="Signal → Action Feed" subtitle="live" scenario>
            <ul className="space-y-2">
              {SIGNAL_FEED.map((f) => (
                <li
                  key={`${f.text}-${f.at}`}
                  className="flex items-start gap-3 rounded-lg border border-gray-100 bg-gray-50/60 px-3 py-2"
                >
                  <span
                    className={`mt-0.5 rounded px-1.5 py-0.5 text-[10px] font-bold ${PRIORITY_META[f.priority]}`}
                  >
                    {PRIORITY_LABEL[f.priority]}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-gray-800">{f.text}</p>
                    <Link
                      href={`/agents/${f.agentId}`}
                      className="text-xs text-brand-600 hover:underline"
                    >
                      → {f.action}
                    </Link>
                  </div>
                  <span className="shrink-0 font-mono text-[10px] text-gray-400">
                    {f.at}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="Next-Best-Action" subtitle="cross-channel" scenario>
            <ul className="space-y-2">
              {NEXT_BEST_ACTIONS.map((n) => (
                <li
                  key={n.rank}
                  className="flex items-center gap-3 rounded-lg border border-gray-100 px-3 py-2"
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700">
                    {n.rank}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-gray-800">{n.title}</p>
                    <p className="text-xs text-gray-400">{n.reason}</p>
                  </div>
                  <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600">
                    {n.channel}
                  </span>
                  <button
                    type="button"
                    className="shrink-0 rounded-md bg-brand-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-700"
                    title="Dispatch layer — planned (Mixmax / Nooks / LinkedIn)"
                  >
                    Dispatch
                  </button>
                </li>
              ))}
            </ul>
          </Panel>
        </div>

        {/* RIGHT — Approval queue (live) + warmth/pipeline */}
        <div className="col-span-12 space-y-4 lg:col-span-3">
          <Panel title="Approval Queue" subtitle="live" live>
            {approvals.length === 0 ? (
              <p className="text-sm text-gray-400">No pending items.</p>
            ) : (
              <ul className="space-y-2">
                {approvals.slice(0, 5).map((a) => (
                  <li
                    key={a.eventId}
                    className="rounded-lg border border-gray-100 px-3 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">
                        {TYPE_LABEL[a.outputType] ?? a.outputType}
                      </span>
                      <StatusBadge variant="pending" label="Review" />
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm text-gray-800">
                      {a.payload?.title ?? "Untitled"}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            <Link
              href="/approvals"
              className="mt-3 block text-xs font-medium text-brand-600 hover:underline"
            >
              Open approval queue →
            </Link>
          </Panel>

          <Panel title="Warmth / Pipeline" subtitle="" scenario>
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-600">Warm accounts</span>
              <span className="font-semibold text-green-600">
                {SCENARIO_KPIS.warmAccounts}
              </span>
            </div>
            <div className="mt-1 flex items-center justify-between text-sm">
              <span className="text-gray-600">Gated (&lt; 0.30)</span>
              <span className="font-semibold text-amber-600">
                {SCENARIO_KPIS.gatedAccounts}
              </span>
            </div>
            <Link
              href="/agents/warmth"
              className="mt-3 block text-xs font-medium text-brand-600 hover:underline"
            >
              How warmth works →
            </Link>
          </Panel>
        </div>
      </div>

      {/* ── GTM Motions — how each is scored + what it drives ────────── */}
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900">
            GTM Motions
            <span className="ml-2 text-xs font-normal text-gray-400">
              how each is scored · what it drives
            </span>
          </h2>
          <span className="h-2 w-2 rounded-full bg-green-500" title="Live data" />
        </div>
        <p className="mb-4 text-xs text-gray-500">
          Fit is scored deterministically from your GTM signals (deal size,
          cycle length, engagement data, content capacity, demand). Top motions
          become Primary; the rest are watched or paused.
        </p>

        {motionData.motions.length === 0 ? (
          <p className="text-sm text-gray-400">No motion scores yet.</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {motionData.motions.map((m) => {
              const meta = motionDisplay(m.label);
              const tier = TIER_META[m.tier];
              const pct = Math.round(m.score * 100);
              return (
                <Link
                  key={m.label}
                  href={`/motion#${m.label}`}
                  className="group block rounded-lg border border-gray-100 p-3 transition-colors hover:border-brand-300 hover:bg-brand-50/30"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-lg">{meta.glyph}</span>
                      <span className="text-sm font-semibold text-gray-900 group-hover:text-brand-700">
                        {meta.name}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-gray-500">
                        {pct}% fit
                      </span>
                      <StatusBadge variant={tier.badge} label={m.tier} />
                    </div>
                  </div>

                  {/* score bar */}
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
                    <div
                      className={`h-full rounded-full ${tier.bar}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>

                  {/* what it drives */}
                  <p className="mt-2 text-xs text-gray-600">{meta.drives}</p>
                  <span className="mt-1 inline-block text-[11px] font-medium text-brand-600 opacity-0 transition-opacity group-hover:opacity-100">
                    See score &amp; why →
                  </span>
                </Link>
              );
            })}
          </div>
        )}

        {motionData.rationale.length > 0 && (
          <div className="mt-4 border-t border-gray-100 pt-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
              Why this mix
            </p>
            <ul className="mt-1.5 space-y-1">
              {motionData.rationale.map((r) => (
                <li key={r} className="flex items-start gap-2 text-xs text-gray-600">
                  <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-gray-300" />
                  {r}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* ── Bottom strip — pipeline flow + channels ──────────────────── */}
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-semibold uppercase tracking-wide text-gray-400">
            Pipeline
          </span>
          {PIPELINE_STAGES.map((s, i) => (
            <span key={s.label} className="flex items-center gap-2">
              <span className="rounded bg-gray-100 px-2 py-1 text-gray-700">
                {s.label} <span className="font-bold">{s.count}</span>
              </span>
              {i < PIPELINE_STAGES.length - 1 && (
                <span className="text-gray-300">▸</span>
              )}
            </span>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-gray-100 pt-4 text-xs">
          <span className="font-semibold uppercase tracking-wide text-gray-400">
            Channels
          </span>
          {CHANNELS.map((c) => {
            const m = CHANNEL_STATE_META[c.state];
            return (
              <span
                key={c.name}
                className="flex items-center gap-1.5 rounded-full bg-gray-50 px-2.5 py-1 ring-1 ring-inset ring-gray-200"
                title={`${m.label} — ${c.note}`}
              >
                <span className={`h-2 w-2 rounded-full ${m.dot}`} />
                <span className="text-gray-700">{c.name}</span>
              </span>
            );
          })}
        </div>
      </div>

      <p className="px-1 text-xs text-gray-400">
        Approval Queue and agent roster are live. Signal feed, next-best-actions,
        channel health and pipeline counts are a demo scenario representing the
        view once the Mixmax/Nooks/LinkedIn/Reddit/SAD adapters and dispatch
        layer are wired.
      </p>
    </div>
  );
}

/* ── Small presentational helpers ──────────────────────────────────── */

function Kpi({
  label,
  value,
  live,
  scenario,
}: {
  label: string;
  value: string | number;
  live?: boolean;
  scenario?: boolean;
}) {
  return (
    <div className="rounded-lg border border-gray-100 bg-gray-50/60 px-3 py-2">
      <div className="flex items-center gap-1.5">
        <span
          className={`h-1.5 w-1.5 rounded-full ${live ? "bg-green-500" : "bg-gray-300"}`}
        />
        <p className="text-[10px] uppercase tracking-wide text-gray-400">
          {label}
        </p>
      </div>
      <p className="mt-0.5 text-xl font-bold text-gray-900">{value}</p>
    </div>
  );
}

function Panel({
  title,
  subtitle,
  children,
  live,
  scenario,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  live?: boolean;
  scenario?: boolean;
}) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">
          {title}
          {subtitle && (
            <span className="ml-2 text-xs font-normal text-gray-400">
              {subtitle}
            </span>
          )}
        </h2>
        {live && <span className="h-2 w-2 rounded-full bg-green-500" title="Live data" />}
        {scenario && (
          <span className="h-2 w-2 rounded-full bg-gray-300" title="Demo scenario" />
        )}
      </div>
      {children}
    </section>
  );
}
