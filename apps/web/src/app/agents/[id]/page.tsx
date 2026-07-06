/**
 * Agent detail — how a single agent works and how it wakes up.
 *
 * Server component; reads the code-grounded catalog. Renders: wake-up trigger,
 * step-by-step behavior, consumes/produces contracts, tunable knobs, LLM usage,
 * and pipeline position.
 */

import { StatusBadge } from "@/components/status-badge";
import { AGENTS, STATUS_META, getAgent } from "@/lib/agent-catalog";
import Link from "next/link";
import { notFound } from "next/navigation";

export function generateStaticParams() {
  return AGENTS.map((a) => ({ id: a.id }));
}

const WAKE_LABEL: Record<string, string> = {
  event: "Triggered by an event",
  chain: "Runs automatically in sequence",
  call: "Runs on demand",
  poll: "Runs on a schedule",
  infra: "Always-on heartbeat",
};

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const agent = getAgent(id);
  if (!agent) notFound();

  const meta = STATUS_META[agent.status];

  return (
    <div className="mx-auto max-w-4xl">
      {/* Breadcrumb */}
      <Link
        href="/agents"
        className="text-sm text-brand-600 hover:underline"
      >
        ← All agents
      </Link>

      {/* Header */}
      <div className="mt-4 flex items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <span className="flex h-14 w-14 items-center justify-center rounded-xl bg-gray-50 text-3xl ring-1 ring-inset ring-gray-200">
            {agent.glyph}
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-gray-900">
              {agent.name}
            </h1>
            <p className="mt-0.5 text-sm text-gray-500">
              {agent.motion} · {agent.category}
            </p>
          </div>
        </div>
        <span className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${meta.dot}`} aria-hidden />
          <StatusBadge variant={meta.badge} label={meta.label} />
        </span>
      </div>

      <p className="mt-4 text-base text-gray-700">{agent.tagline}</p>

      {/* ── How it wakes up (the headline) ─────────────────────────────── */}
      <section className="mt-8 rounded-xl border border-brand-200 bg-brand-50/40 p-5">
        <div className="flex items-center gap-2">
          <span className="text-lg">⏰</span>
          <h2 className="text-sm font-semibold text-gray-900">How it wakes up</h2>
          <span className="ml-auto rounded-full bg-white px-2.5 py-0.5 text-xs font-medium text-brand-700 ring-1 ring-inset ring-brand-200">
            {WAKE_LABEL[agent.wakeUp.kind]}
          </span>
        </div>
        <p className="mt-2 text-sm text-gray-700">{agent.wakeUp.summary}</p>
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-white px-3 py-2 ring-1 ring-inset ring-brand-100">
          <span className="text-brand-500">⚡</span>
          <span className="text-sm font-medium text-gray-800">
            {agent.wakeUp.trigger}
          </span>
        </div>
      </section>

      {/* ── How it works ───────────────────────────────────────────────── */}
      <section className="mt-6 rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-gray-900">How it works</h2>
        <ol className="mt-3 space-y-3">
          {agent.howItWorks.map((step, i) => (
            <li key={step} className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700">
                {i + 1}
              </span>
              <span className="text-sm text-gray-700">{step}</span>
            </li>
          ))}
        </ol>
      </section>

      {/* ── Contracts: consumes / produces ─────────────────────────────── */}
      <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
        <section className="rounded-xl border border-gray-200 bg-white p-5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400">
            Consumes
          </h2>
          <ul className="mt-3 space-y-2">
            {agent.consumes.map((c) => (
              <li key={c} className="flex items-start gap-2 text-sm text-gray-700">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-400" />
                <span>{c}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="rounded-xl border border-gray-200 bg-white p-5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400">
            Produces
          </h2>
          <ul className="mt-3 space-y-2">
            {agent.produces.map((p) => (
              <li key={p} className="flex items-start gap-2 text-sm text-gray-700">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-green-500" />
                <span>{p}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {/* ── Knobs + LLM + pipeline ─────────────────────────────────────── */}
      <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
        {agent.knobs && agent.knobs.length > 0 && (
          <section className="rounded-xl border border-gray-200 bg-white p-5">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400">
              Tunables
            </h2>
            <dl className="mt-3 space-y-2">
              {agent.knobs.map((k) => (
                <div key={k.label} className="flex items-center justify-between text-sm">
                  <dt className="text-gray-600">{k.label}</dt>
                  <dd className="font-mono text-xs font-medium text-gray-900">
                    {k.value}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        )}

        <section className="rounded-xl border border-gray-200 bg-white p-5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400">
            Intelligence
          </h2>
          <div className="mt-3 space-y-2 text-sm">
            {agent.pipeline && (
              <div className="flex items-center justify-between">
                <span className="text-gray-600">Pipeline</span>
                <span className="font-medium text-gray-900">{agent.pipeline}</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-gray-600">Uses LLM</span>
              <span className="font-medium text-gray-900">
                {agent.llm?.used ? (agent.llm.model ?? "yes") : "no (deterministic)"}
              </span>
            </div>
            {agent.llm?.fallback && (
              <div className="flex items-center justify-between">
                <span className="text-gray-600">If AI is unavailable</span>
                <span className="text-xs text-gray-500">{agent.llm.fallback}</span>
              </div>
            )}
          </div>
        </section>
      </div>

      {/* ── Technical details (collapsed — for engineers, not the demo) ─── */}
      {agent.technical && (
        <details className="mt-6 rounded-xl border border-gray-200 bg-gray-50/60 p-4">
          <summary className="cursor-pointer text-xs font-medium text-gray-500 hover:text-gray-700">
            Technical details (for engineers)
          </summary>
          <dl className="mt-3 space-y-2 font-mono text-[11px] text-gray-600">
            {agent.technical.trigger && (
              <div>
                <dt className="text-gray-400">trigger</dt>
                <dd className="break-all text-gray-700">{agent.technical.trigger}</dd>
              </div>
            )}
            {agent.technical.queueGroup && (
              <div>
                <dt className="text-gray-400">queue group</dt>
                <dd className="break-all text-gray-700">{agent.technical.queueGroup}</dd>
              </div>
            )}
            {agent.technical.produces && agent.technical.produces.length > 0 && (
              <div>
                <dt className="text-gray-400">emits</dt>
                <dd className="break-all text-gray-700">
                  {agent.technical.produces.join(", ")}
                </dd>
              </div>
            )}
            {agent.technical.sourceFile && (
              <div>
                <dt className="text-gray-400">source</dt>
                <dd className="break-all text-gray-700">{agent.technical.sourceFile}</dd>
              </div>
            )}
          </dl>
        </details>
      )}

      {agent.status === "planned" && (
        <div className="mt-6 rounded-lg bg-amber-50 p-4 text-sm text-amber-800">
          <strong>Planned agent.</strong> The routing target / signal source
          exists today; the worker is a next-build, cloning the proven Intel
          Director pattern.
        </div>
      )}
    </div>
  );
}
