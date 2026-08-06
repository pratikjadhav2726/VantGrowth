/**
 * Agent Roster — a clickable map of every agent in the platform.
 *
 * Grouped by pipeline category. Each card links to /agents/[id] which explains
 * how that agent works and, crucially, HOW IT WAKES UP. Data comes from the
 * code-grounded catalog in @/lib/agent-catalog.
 */

import { StatusBadge } from "@/components/status-badge";
import { AGENTS, AGENT_CATEGORIES, STATUS_META } from "@/lib/agent-catalog";
import Link from "next/link";

export default function AgentsPage() {
  const activeCount = AGENTS.filter((a) => a.status === "active").length;
  const plannedCount = AGENTS.filter((a) => a.status === "planned").length;

  return (
    <div>
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">
          Agent Roster
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-gray-500">
          Every intelligent agent in the platform — what it does and how it
          wakes up. Click any agent for its pipeline, triggers, and live
          behavior. {activeCount} live · {plannedCount} planned.
        </p>
      </div>

      {/* How agents wake up — the shared mechanism, in plain terms */}
      <div className="mb-8 rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-gray-900">
          How every agent wakes up
        </h2>
        <p className="mt-1 text-sm text-gray-600">
          Agents don't run on a timer — they react. The moment something happens
          (a reply comes in, a competitor moves, a meeting ends), the{" "}
          <Link
            href="/agents/outbox-publisher"
            className="font-medium text-brand-600 hover:underline"
          >
            system heartbeat
          </Link>{" "}
          notices it and instantly wakes the right agent to act.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-gray-600">
          <span className="rounded-full bg-gray-100 px-3 py-1">
            Something happens
          </span>
          <span className="text-gray-300">→</span>
          <span className="rounded-full bg-gray-100 px-3 py-1">
            Heartbeat notices
          </span>
          <span className="text-gray-300">→</span>
          <span className="rounded-full bg-gray-100 px-3 py-1">
            Routed by urgency
          </span>
          <span className="text-gray-300">→</span>
          <span className="rounded-full bg-brand-50 px-3 py-1 font-medium text-brand-700">
            The right agent acts
          </span>
        </div>
      </div>

      {/* Roster grouped by category */}
      {AGENT_CATEGORIES.map((category) => {
        const agents = AGENTS.filter((a) => a.category === category);
        if (agents.length === 0) return null;
        return (
          <section key={category} className="mb-8">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-400">
              {category}
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {agents.map((agent) => {
                const meta = STATUS_META[agent.status];
                return (
                  <Link
                    key={agent.id}
                    href={`/agents/${agent.id}`}
                    className="group flex flex-col rounded-xl border border-gray-200 bg-white p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-brand-500"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-50 text-xl ring-1 ring-inset ring-gray-200">
                          {agent.glyph}
                        </span>
                        <div>
                          <h3 className="text-sm font-semibold text-gray-900 leading-tight group-hover:text-brand-700">
                            {agent.name}
                          </h3>
                          <p className="text-xs text-gray-400">
                            {agent.motion}
                          </p>
                        </div>
                      </div>
                      <span className="flex items-center gap-1.5">
                        <span
                          className={`h-2 w-2 rounded-full ${meta.dot}`}
                          aria-hidden
                        />
                        <StatusBadge variant={meta.badge} label={meta.label} />
                      </span>
                    </div>

                    <p className="mt-3 flex-1 text-sm text-gray-600">
                      {agent.tagline}
                    </p>

                    {/* How it wakes up — the headline fact */}
                    <div className="mt-4 rounded-lg bg-gray-50 px-3 py-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                        Wakes up
                      </p>
                      <p className="mt-0.5 text-xs text-gray-700 line-clamp-2">
                        {agent.wakeUp.trigger}
                      </p>
                    </div>

                    <span className="mt-4 text-xs font-medium text-brand-600 group-hover:underline">
                      View how it works →
                    </span>
                  </Link>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
