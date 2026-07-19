/**
 * Command Center — the one-page operational view.
 *
 * LIVE: the tenant-scoped control-plane snapshot and approval queue.
 * DEMO SCENARIO (explicitly labeled below): signal feed, next-best-actions,
 * channel health, warmth, and pipeline examples.
 */

import { StatusBadge } from "@/components/status-badge";
import { AGENTS, STATUS_META } from "@/lib/agent-catalog";
import {
  type ControlPlaneHealthResponse,
  type ControlPlaneIncidentResponse,
  type ControlPlaneSummary,
  getControlPlaneHealth,
  getControlPlaneSummary,
  getMotionOverview,
  listApprovals,
  listControlPlaneIncidents,
} from "@/lib/api-client";
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
import {
  type MotionTier,
  TIER_META,
  motionDisplay,
} from "@/lib/motion-catalog";
import Link from "next/link";

const DEV_TENANT_ID =
  process.env.GROWTHOS_DEV_TENANT_ID ?? "00000000-0000-0000-0001-000000000001";

interface ApprovalItem {
  eventId: string;
  outputType: string;
  payload: { title?: string; meta_description?: string };
}

interface ApprovalLoad {
  items: ApprovalItem[];
  failed: boolean;
}

const TYPE_LABEL: Record<string, string> = {
  "blog_draft.v1": "Blog",
  "content_brief.v1": "Brief",
  "intel_brief.v1": "Intel",
};

async function loadApprovals(): Promise<ApprovalLoad> {
  try {
    const types = ["intel_brief.v1", "blog_draft.v1", "content_brief.v1"];
    const results = await Promise.allSettled(
      types.map((type) =>
        listApprovals(DEV_TENANT_ID, { outputType: type, limit: 5 }),
      ),
    );
    return {
      items: results.flatMap((result) =>
        result.status === "fulfilled"
          ? (result.value.items as ApprovalItem[])
          : [],
      ),
      failed: results.some((result) => result.status === "rejected"),
    };
  } catch {
    return { items: [], failed: true };
  }
}

interface ScoredMotion {
  label: string;
  score: number;
  tier: MotionTier;
}

async function loadMotions(): Promise<{
  motions: ScoredMotion[];
  rationale: string[];
  failed: boolean;
}> {
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
      .map(([label, score]) => ({
        label,
        score: Number(score),
        tier: tierOf(label),
      }))
      .sort((a, b) => b.score - a.score);
    return {
      motions,
      rationale: overview.latestScore?.rationale ?? [],
      failed: false,
    };
  } catch {
    return { motions: [], rationale: [], failed: true };
  }
}

type ControlPlaneSource = keyof ControlPlaneSummary["dataSources"];
type ControlPlaneSourceStatus =
  ControlPlaneSummary["dataSources"][ControlPlaneSource];

interface ControlPlaneLoad<T> {
  data: T | null;
  failed: boolean;
}

interface OperationalSnapshot {
  summary: ControlPlaneLoad<ControlPlaneSummary>;
  health: ControlPlaneLoad<ControlPlaneHealthResponse>;
  incidents: ControlPlaneLoad<ControlPlaneIncidentResponse>;
}

const loadControlPlaneResource = async <T,>(
  loader: () => Promise<T>,
): Promise<ControlPlaneLoad<T>> => {
  try {
    return { data: await loader(), failed: false };
  } catch {
    return { data: null, failed: true };
  }
};

async function loadOperationalSnapshot(): Promise<OperationalSnapshot> {
  const [summary, health, incidents] = await Promise.all([
    loadControlPlaneResource(() => getControlPlaneSummary(DEV_TENANT_ID)),
    loadControlPlaneResource(() => getControlPlaneHealth(DEV_TENANT_ID, 25)),
    loadControlPlaneResource(() =>
      listControlPlaneIncidents(DEV_TENANT_ID, 10),
    ),
  ]);
  return { summary, health, incidents };
}

const sourceStatus = (
  snapshot: OperationalSnapshot,
  source: ControlPlaneSource,
  endpointAvailable = false,
): ControlPlaneSourceStatus =>
  snapshot.summary.data?.dataSources[source] ??
  (endpointAvailable ? "available" : "unavailable");

const isSourceAvailable = (status: ControlPlaneSourceStatus): boolean =>
  status === "available";

const sourceLabel: Record<ControlPlaneSource, string> = {
  signals: "Signals",
  outbox: "Outbox",
  approvals: "Approvals",
  motion: "Motion",
  componentHealth: "Health",
  incidents: "Incidents",
  experiments: "Experiments",
  learningProposals: "Learning",
};

const sourceStatusMeta: Record<
  ControlPlaneSourceStatus,
  { label: string; dot: string; chip: string }
> = {
  available: {
    label: "Available",
    dot: "bg-green-500",
    chip: "bg-green-50 text-green-700 ring-green-200",
  },
  not_configured: {
    label: "Not configured",
    dot: "bg-gray-400",
    chip: "bg-gray-100 text-gray-600 ring-gray-200",
  },
  unavailable: {
    label: "Unavailable",
    dot: "bg-amber-500",
    chip: "bg-amber-50 text-amber-800 ring-amber-200",
  },
};

export default async function CommandCenterPage() {
  const [approvalLoad, motionData, operational] = await Promise.all([
    loadApprovals(),
    loadMotions(),
    loadOperationalSnapshot(),
  ]);
  const approvals = approvalLoad.items;
  const roster = AGENTS.filter((a) => a.category !== "Infrastructure");
  const summary = operational.summary.data;
  const signalsSource = sourceStatus(operational, "signals");
  const outboxSource = sourceStatus(operational, "outbox");
  const approvalsSource = sourceStatus(operational, "approvals");
  const motionSource = sourceStatus(operational, "motion");
  const experimentsSource = sourceStatus(operational, "experiments");
  const learningSource = sourceStatus(operational, "learningProposals");
  const healthSource = sourceStatus(
    operational,
    "componentHealth",
    operational.health.data !== null,
  );
  const incidentsSource = sourceStatus(
    operational,
    "incidents",
    operational.incidents.data !== null,
  );
  const healthOverall = isSourceAvailable(healthSource)
    ? (operational.health.data?.overall ?? summary?.health.overall ?? null)
    : null;
  const healthComponents = isSourceAvailable(healthSource)
    ? (operational.health.data?.total ?? summary?.health.components ?? null)
    : null;
  const openIncidents = isSourceAvailable(incidentsSource)
    ? (operational.incidents.data?.open ?? summary?.incidents.open ?? null)
    : null;
  const criticalIncidents = isSourceAvailable(incidentsSource)
    ? (summary?.incidents.criticalOpen ?? null)
    : null;
  const isPartial =
    summary === null ||
    summary.partial ||
    operational.health.failed ||
    operational.incidents.failed;
  const controlPlaneLabel =
    summary === null
      ? "Control-plane summary unavailable"
      : isPartial
        ? "Partial control-plane data"
        : "Live control-plane data";
  const primaryMotions = summary?.motion.primaryMotions ?? [];

  return (
    <div className="space-y-4">
      {/* ── Live tenant-scoped operational snapshot ─────────────────── */}
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-gray-900">
              Founder Command Center
            </h1>
            <p className="text-sm text-gray-500">
              Tenant-scoped operating snapshot
              {isSourceAvailable(motionSource) && (
                <>
                  {" · "}Motion:{" "}
                  <span className="font-medium text-gray-700">
                    {primaryMotions.length > 0
                      ? primaryMotions.join(", ")
                      : "No primary motion"}
                  </span>
                </>
              )}
            </p>
          </div>
          <ControlPlaneState
            label={controlPlaneLabel}
            summaryUnavailable={summary === null}
            partial={isPartial}
          />
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
          <OperationalKpi
            label="Signals today"
            value={
              isSourceAvailable(signalsSource)
                ? (summary?.signals.today ?? null)
                : null
            }
            sourceStatus={signalsSource}
            detail={
              isSourceAvailable(signalsSource)
                ? "Ingested since the current UTC day began"
                : undefined
            }
          />
          <OperationalKpi
            label="Pending outbox"
            value={
              isSourceAvailable(outboxSource)
                ? (summary?.execution.pendingOutboxEvents ?? null)
                : null
            }
            sourceStatus={outboxSource}
            lowerBound={summary?.execution.pendingOutboxEventsIsLowerBound}
            detail="Durable events awaiting delivery"
          />
          <OperationalKpi
            label="Pending approvals"
            value={
              isSourceAvailable(approvalsSource)
                ? (summary?.approvals.pending ?? null)
                : null
            }
            sourceStatus={approvalsSource}
            lowerBound={summary?.approvals.pendingIsLowerBound}
            detail={
              isSourceAvailable(approvalsSource) && summary
                ? `${summary.approvals.approvedLastSevenDays} approved · ${summary.approvals.rejectedLastSevenDays} rejected / 7d`
                : undefined
            }
          />
          <OperationalKpi
            label="Experiments"
            value={
              isSourceAvailable(experimentsSource)
                ? (summary?.experiments.total ?? null)
                : null
            }
            sourceStatus={experimentsSource}
            detail={
              isSourceAvailable(experimentsSource) && summary
                ? `${summary.experiments.running} running · ${summary.experiments.paused} paused`
                : undefined
            }
          />
          <OperationalKpi
            label="Learning proposals"
            value={
              isSourceAvailable(learningSource)
                ? (summary?.learning.total ?? null)
                : null
            }
            sourceStatus={learningSource}
            detail={
              isSourceAvailable(learningSource) && summary
                ? `${summary.learning.awaitingEvidence} awaiting evidence · ${summary.learning.requiresApproval} need approval`
                : undefined
            }
          />
          <OperationalKpi
            label="Components"
            value={healthComponents}
            sourceStatus={healthSource}
            lowerBound={
              operational.health.data?.totalIsLowerBound ??
              summary?.health.componentsIsLowerBound
            }
            detail={
              healthOverall
                ? `Overall: ${healthOverall.replaceAll("_", " ")}`
                : undefined
            }
          />
          <OperationalKpi
            label="Open incidents"
            value={openIncidents}
            sourceStatus={incidentsSource}
            lowerBound={summary?.incidents.openIsLowerBound}
            detail={
              criticalIncidents === null
                ? undefined
                : `${criticalIncidents} critical open`
            }
          />
        </div>

        <div className="mt-4 border-t border-gray-100 pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
              Data sources
            </span>
            {(Object.keys(sourceLabel) as ControlPlaneSource[]).map(
              (source) => (
                <SourceAvailability
                  key={source}
                  label={sourceLabel[source]}
                  status={sourceStatus(
                    operational,
                    source,
                    (source === "componentHealth" &&
                      operational.health.data !== null) ||
                      (source === "incidents" &&
                        operational.incidents.data !== null),
                  )}
                />
              ),
            )}
          </div>
          {(operational.health.failed || operational.incidents.failed) && (
            <p className="mt-2 text-xs text-amber-700">
              {operational.health.failed &&
                "Health detail endpoint unavailable"}
              {operational.health.failed &&
                operational.incidents.failed &&
                "; "}
              {operational.incidents.failed &&
                "Incident detail endpoint unavailable"}
              {
                ". Summary counts above remain scoped to their reported sources."
              }
            </p>
          )}
        </div>
      </div>

      {/* ── Main 3-column grid ───────────────────────────────────────── */}
      <div className="grid grid-cols-12 gap-4">
        {/* LEFT — agent catalog */}
        <div className="col-span-12 lg:col-span-3">
          <Panel title="Agent Roster" subtitle="catalog">
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
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${meta.dot}`}
                      />
                      <span className="flex-1 truncate text-gray-700">
                        {a.name}
                      </span>
                      <span className="font-mono text-[10px] text-gray-400">
                        {rt?.lastRun
                          ? `✓${rt.lastRun}`
                          : (rt?.queue ?? meta.label)}
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
          <Panel title="Signal → Action Feed" subtitle="Demo scenario" scenario>
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

          <Panel title="Next-Best-Action" subtitle="Demo scenario" scenario>
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
          <Panel
            title="Approval Queue"
            subtitle={approvalLoad.failed ? "partial" : "live"}
            live={!approvalLoad.failed}
          >
            {approvalLoad.failed && approvals.length === 0 ? (
              <p className="text-sm text-amber-700">
                Approval data is currently unavailable.
              </p>
            ) : approvals.length === 0 ? (
              <p className="text-sm text-gray-400">No pending items.</p>
            ) : (
              <>
                {approvalLoad.failed && (
                  <p className="mb-2 text-xs text-amber-700">
                    Some approval sources are unavailable.
                  </p>
                )}
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
              </>
            )}
            <Link
              href="/approvals"
              className="mt-3 block text-xs font-medium text-brand-600 hover:underline"
            >
              Open approval queue →
            </Link>
          </Panel>

          <Panel title="Warmth / Pipeline" subtitle="Demo scenario" scenario>
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
          <span
            className={`h-2 w-2 rounded-full ${motionData.failed ? "bg-amber-500" : "bg-green-500"}`}
            title={motionData.failed ? "Motion data unavailable" : "Live data"}
          />
        </div>
        <p className="mb-4 text-xs text-gray-500">
          Fit is scored deterministically from your GTM signals (deal size,
          cycle length, engagement data, content capacity, demand). Top motions
          become Primary; the rest are watched or paused.
        </p>

        {motionData.failed ? (
          <p className="text-sm text-amber-700">
            Motion data is currently unavailable.
          </p>
        ) : motionData.motions.length === 0 ? (
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
                <li
                  key={r}
                  className="flex items-start gap-2 text-xs text-gray-600"
                >
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
            Pipeline demo
          </span>
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500">
            Demo scenario
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
            Demo channels
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
        The operational snapshot, Approval Queue, and GTM Motions use
        tenant-scoped API data when available. The agent catalog, signal feed,
        next-best-actions, warmth, channel health, and pipeline strip are
        explicitly labeled demo scenarios.
      </p>
    </div>
  );
}

/* ── Small presentational helpers ──────────────────────────────────── */

function ControlPlaneState({
  label,
  summaryUnavailable,
  partial,
}: {
  label: string;
  summaryUnavailable: boolean;
  partial: boolean;
}) {
  const meta = summaryUnavailable
    ? { dot: "bg-amber-500", text: "text-amber-800", title: "Unavailable" }
    : partial
      ? { dot: "bg-amber-500", text: "text-amber-800", title: "Partial" }
      : { dot: "bg-green-500", text: "text-green-800", title: "Live" };

  return (
    <span
      className={`flex items-center gap-1.5 text-xs font-medium ${meta.text}`}
      title={meta.title}
    >
      <span className={`h-2 w-2 rounded-full ${meta.dot}`} />
      {label}
    </span>
  );
}

function SourceAvailability({
  label,
  status,
}: {
  label: string;
  status: ControlPlaneSourceStatus;
}) {
  const meta = sourceStatusMeta[status];
  return (
    <span
      className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset ${meta.chip}`}
      title={`${label}: ${meta.label}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
      {label}: {meta.label}
    </span>
  );
}

function OperationalKpi({
  label,
  value,
  sourceStatus,
  lowerBound = false,
  detail,
}: {
  label: string;
  value: number | null;
  sourceStatus: ControlPlaneSourceStatus;
  lowerBound?: boolean | undefined;
  detail?: string | undefined;
}) {
  const meta = sourceStatusMeta[sourceStatus];
  const visibleValue =
    value === null ? "—" : `${lowerBound ? "≥" : ""}${value}`;

  return (
    <div className="rounded-lg border border-gray-100 bg-gray-50/60 px-3 py-2">
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
        <p className="text-[10px] uppercase tracking-wide text-gray-400">
          {label}
        </p>
      </div>
      <p className="mt-0.5 text-xl font-bold text-gray-900">{visibleValue}</p>
      <p className="mt-0.5 line-clamp-2 text-[10px] leading-4 text-gray-500">
        {value === null ? meta.label : (detail ?? meta.label)}
      </p>
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
        {live && (
          <span
            className="h-2 w-2 rounded-full bg-green-500"
            title="Live data"
          />
        )}
        {scenario && (
          <span
            className="h-2 w-2 rounded-full bg-gray-300"
            title="Demo scenario"
          />
        )}
      </div>
      {children}
    </section>
  );
}
