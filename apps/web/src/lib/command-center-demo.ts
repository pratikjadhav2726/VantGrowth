/**
 * Command Center — demo scenario data.
 *
 * The Approval Queue on the real page is LIVE (from /v1/approvals). Everything
 * in this module is a labeled demo scenario representing what the page shows
 * once the ingestion adapters (Mixmax/Nooks/LinkedIn/Reddit/SAD) and the
 * dispatch layer are wired. Kept separate so it's obvious what is real vs.
 * illustrative.
 */

export interface FeedItem {
  priority: "P0" | "P1" | "P2" | "P3" | "—";
  text: string;
  action: string;
  agentId: string; // links into the agent roster
  at: string;
}

export interface NextBestAction {
  rank: number;
  title: string;
  channel: "Nooks" | "Mixmax" | "LinkedIn" | "Reddit";
  reason: string;
}

export interface ChannelHealth {
  name: string;
  state: "connected" | "ready" | "planned";
  note: string;
}

export const SCENARIO_KPIS = {
  signalsToday: 142,
  nbasPending: 18,
  warmAccounts: 37,
  gatedAccounts: 12,
  pipelineValue: "$2.4M",
  motion: "Warm Outbound + Lifecycle",
};

export const SIGNAL_FEED: FeedItem[] = [
  {
    priority: "P0",
    text: "Madison Apartment Group replied to email",
    action: "Warm Outbound drafting follow-up",
    agentId: "warm-outbound-researcher",
    at: "09:41",
  },
  {
    priority: "P1",
    text: "Competitor launched a PMC insurance program",
    action: "Intel Director brief ready",
    agentId: "intel-director",
    at: "09:38",
  },
  {
    priority: "P2",
    text: "Yardi PMC went cold (6 days, active thread)",
    action: "re-engage draft queued",
    agentId: "warm-outbound-researcher",
    at: "09:30",
  },
  {
    priority: "—",
    text: "Smart Apartment Data: Madison +1,200 units",
    action: "expansion play (Lifecycle)",
    agentId: "lifecycle-expansion",
    at: "09:12",
  },
  {
    priority: "—",
    text: "Reddit r/multifamily mention of forced-place insurance",
    action: "Community reply drafted",
    agentId: "community",
    at: "08:55",
  },
];

export const NEXT_BEST_ACTIONS: NextBestAction[] = [
  { rank: 1, title: "Call Madison Apartment Group (Heat 95)", channel: "Nooks", reason: "P0 reply + warm" },
  { rank: 2, title: "Follow up Globex (cold 4 days)", channel: "Mixmax", reason: "re-engage sequence" },
  { rank: 3, title: "Warm Jane Doe's feed before outreach", channel: "LinkedIn", reason: "warmth 0.22 → build" },
];

export const PIPELINE_STAGES = [
  { label: "Signals", count: 142 },
  { label: "Research", count: 9 },
  { label: "Content", count: 7 },
  { label: "Review", count: 7 },
  { label: "Approvals", count: 6 },
  { label: "Sent", count: 23 },
];

export const CHANNELS: ChannelHealth[] = [
  { name: "Salesforce", state: "connected", note: "via bdr-micro mirror" },
  { name: "Smart Apt Data", state: "ready", note: "via Salesforce sync" },
  { name: "Mixmax", state: "planned", note: "ingestion adapter" },
  { name: "Nooks", state: "planned", note: "ingestion adapter" },
  { name: "LinkedIn", state: "planned", note: "persona events" },
  { name: "Reddit", state: "planned", note: "subreddit poll" },
];

/** Scenario heartbeat status per agent id (for the roster column). */
export const AGENT_RUNTIME: Record<string, { lastRun?: string; queue?: string }> = {
  "signal-router": { lastRun: "5s" },
  "intel-director": { lastRun: "2m" },
  "content-strategist": { lastRun: "4m" },
  "blog-draft": { lastRun: "6m" },
  critique: { lastRun: "3m" },
  learning: { lastRun: "1m" },
  warmth: { lastRun: "40s" },
  "warm-outbound-researcher": { queue: "sig 3" },
  "lifecycle-expansion": { queue: "—" },
  community: { queue: "—" },
  "outbox-publisher": { lastRun: "1s" },
};

export const CHANNEL_STATE_META: Record<
  ChannelHealth["state"],
  { dot: string; label: string }
> = {
  connected: { dot: "bg-green-500", label: "Connected" },
  ready: { dot: "bg-blue-500", label: "Ready" },
  planned: { dot: "bg-amber-500", label: "Planned" },
};

export const PRIORITY_META: Record<FeedItem["priority"], string> = {
  P0: "bg-red-100 text-red-700",
  P1: "bg-orange-100 text-orange-700",
  P2: "bg-amber-100 text-amber-700",
  P3: "bg-gray-100 text-gray-600",
  "—": "bg-gray-100 text-gray-500",
};

/** Plain-English urgency labels (no P0/P1 codes in front of the CEO). */
export const PRIORITY_LABEL: Record<FeedItem["priority"], string> = {
  P0: "Urgent",
  P1: "High",
  P2: "Normal",
  P3: "Low",
  "—": "Info",
};
