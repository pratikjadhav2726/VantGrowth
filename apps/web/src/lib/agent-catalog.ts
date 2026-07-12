/**
 * Agent catalog — the source of truth for the Agent Roster UI.
 *
 * Default fields use plain business language (for demos / operators). The
 * deeper engineering detail (event subjects, queue groups, source files) lives
 * in the optional `technical` block, which the UI shows only inside a collapsed
 * "Technical details" disclosure — never in the default view.
 */

export type AgentStatus = "active" | "idle" | "planned";

export type WakeKind = "event" | "chain" | "call" | "poll" | "infra";

export interface AgentTechnical {
  trigger?: string; // raw subject / endpoint
  queueGroup?: string;
  sourceFile?: string;
  consumes?: string[]; // raw event contracts
  produces?: string[];
}

export interface AgentWakeUp {
  kind: WakeKind;
  /** Plain-English "how does this agent wake up?" */
  summary: string;
  /** Short plain-English trigger phrase shown on the card + detail. */
  trigger: string;
}

export interface AgentDef {
  id: string;
  name: string;
  glyph: string;
  category:
    | "Intelligence"
    | "Content"
    | "Quality"
    | "Outbound"
    | "Lifecycle"
    | "Infrastructure";
  motion: string;
  tagline: string;
  status: AgentStatus;
  wakeUp: AgentWakeUp;
  /** Plain-English inputs. */
  consumes: string[];
  /** Plain-English outputs. */
  produces: string[];
  llm?: { used: boolean; model?: string; fallback?: string };
  howItWorks: string[];
  pipeline?: string;
  knobs?: { label: string; value: string }[];
  technical?: AgentTechnical;
}

export const AGENTS: AgentDef[] = [
  // ─── Intelligence ────────────────────────────────────────────────────────
  {
    id: "signal-router",
    name: "Signal Router",
    glyph: "⇄",
    category: "Intelligence",
    motion: "All motions",
    tagline:
      "The front door — sorts every incoming signal by urgency and sends it to the right agent.",
    status: "active",
    wakeUp: {
      kind: "call",
      summary:
        "Wakes the instant any new signal arrives — an email reply, a call outcome, a competitor move, a community mention. It decides how urgent the signal is and which agent should handle it.",
      trigger: "Whenever a new signal arrives from any channel",
    },
    consumes: [
      "New signals from email, calls, social, competitors and the web",
    ],
    produces: ["A prioritized signal handed to the right agent"],
    llm: {
      used: true,
      model: "AI-assisted grading (optional)",
      fallback: "instant rule-based routing",
    },
    howItWorks: [
      "A new signal arrives and is de-duplicated so nothing is counted twice.",
      "It is graded for urgency in a fraction of a second and matched to the right agent.",
      "Urgent prospect replies go to outbound in 30 minutes; competitor moves go to the Intel Director; rejections feed the learning loop.",
      "Optionally an AI pass scores relevance and topic — but routing still works instantly even without it.",
      "The chosen agent is woken up to act.",
    ],
    pipeline: "Entry point",
    knobs: [
      { label: "Urgent — act within", value: "30 minutes" },
      { label: "High — act within", value: "2 hours" },
      { label: "Normal — act within", value: "24 hours" },
      { label: "Low — act within", value: "7 days" },
    ],
    technical: {
      trigger: "POST /v1/signals → SignalRouter.route()",
      produces: ["signal.routed.v1"],
      sourceFile: "apps/worker-signal-router/src/signal-router.ts",
    },
  },
  {
    id: "intel-director",
    name: "Intel Director",
    glyph: "🛰",
    category: "Intelligence",
    motion: "Inbound · Community",
    tagline:
      "Competitor search & track — turns market and competitor activity into a clear brief.",
    status: "active",
    wakeUp: {
      kind: "event",
      summary:
        "Wakes on the weekly market sweep, or immediately when the Signal Router flags a competitor move. It then researches what's changing and writes a brief.",
      trigger: "Weekly, or instantly when a competitor makes a move",
    },
    consumes: [
      "Competitor activity, community discussion, and your market positioning",
    ],
    produces: [
      "An intelligence brief: what changed, why it matters, and recommended plays",
    ],
    llm: {
      used: true,
      model: "AI-generated brief",
      fallback: "structured baseline brief",
    },
    howItWorks: [
      "Triggered by the weekly sweep or a flagged competitor move.",
      "Gathers competitor signals (pricing, launches, reviews) and community chatter for the period.",
      "Writes a structured brief: what competitors did, why it matters to you, and recommended content and outreach plays.",
      "Always produces a brief even with no AI key — it never stalls.",
      "Hands the brief to the Content Strategist.",
    ],
    pipeline: "Stage 1 of 4 (content engine)",
    technical: {
      trigger: "intel_brief.requested.v1",
      queueGroup: "growthos-worker-intel-director",
      produces: ["intel_brief.v1"],
      sourceFile: "apps/worker-intel-director/src/intel-director-worker.ts",
    },
  },

  // ─── Content ───────────────────────────────────────────────────────────────
  {
    id: "content-strategist",
    name: "Content Strategist",
    glyph: "✍",
    category: "Content",
    motion: "Inbound",
    tagline:
      "Turns each intel opportunity into a briefed, ready-to-write content plan.",
    status: "active",
    wakeUp: {
      kind: "chain",
      summary:
        "Runs automatically the moment the Intel Director finishes a brief.",
      trigger: "Automatically, as soon as an intel brief is ready",
    },
    consumes: ["An intelligence brief"],
    produces: [
      "A content plan: outline, keywords, tone, audience and call-to-action",
    ],
    llm: {
      used: true,
      model: "AI-generated plan",
      fallback: "structured outline",
    },
    howItWorks: [
      "Takes each opportunity from the intel brief.",
      "Builds a content plan with outline, keywords, tone, target persona and CTA.",
      "Passes the plan to the Draft Writer.",
    ],
    pipeline: "Stage 2 of 4",
    technical: {
      trigger: "intel_brief.v1",
      queueGroup: "growthos-worker-content-strategist",
      produces: ["content_opportunity.v1", "content_brief.v1"],
      sourceFile:
        "apps/worker-content-strategist/src/content-strategist-worker.ts",
    },
  },
  {
    id: "blog-draft",
    name: "Draft Writer",
    glyph: "📝",
    category: "Content",
    motion: "Inbound",
    tagline:
      "Writes the full draft from a content plan, with built-in quality checks.",
    status: "active",
    wakeUp: {
      kind: "chain",
      summary:
        "Runs automatically once the Content Strategist finishes a plan.",
      trigger: "Automatically, once a content plan is ready",
    },
    consumes: ["A content plan"],
    produces: [
      "A finished draft with quality checks (CTA, structure, readability)",
    ],
    llm: {
      used: true,
      model: "AI-written draft",
      fallback: "structured skeleton",
    },
    howItWorks: [
      "Takes the plan's outline and writes the full piece.",
      "Runs quality checks: call-to-action present, internal links, structure, readability.",
      "Sends the draft for review — first to the automatic reviewer, then the human Approval Queue.",
    ],
    pipeline: "Stage 3 of 4",
    technical: {
      trigger: "content_brief.v1",
      queueGroup: "growthos-worker-blog-draft",
      produces: ["blog_draft.v1"],
      sourceFile: "apps/worker-blog-draft/src/blog-draft-worker.ts",
    },
  },

  // ─── Quality + Learning ──────────────────────────────────────────────────
  {
    id: "critique",
    name: "Quality Reviewer",
    glyph: "🔎",
    category: "Quality",
    motion: "All motions",
    tagline:
      "An automatic second opinion — scores every draft and flags anything that needs a human.",
    status: "active",
    wakeUp: {
      kind: "chain",
      summary: "Runs on every draft before it can reach a human or be sent.",
      trigger: "Every time a draft is produced",
    },
    consumes: ["Any drafted content, plus reviewer notes"],
    produces: [
      "A confidence score and a verdict: approve, revise, or send to human review",
    ],
    llm: {
      used: true,
      model: "AI quality review",
      fallback: "rule-based scoring",
    },
    howItWorks: [
      "Scores every draft for quality — checking call-to-action, evidence, length, structure and tone.",
      "High-confidence work can be auto-approved; anything weaker is routed to a human with the reasons attached.",
      "Always returns a score, even with no AI key.",
      "Its verdicts also feed the learning loop so the system keeps improving.",
    ],
    pipeline: "Stage 4 of 4 (quality gate)",
    knobs: [
      { label: "Auto-approve when confidence", value: "≥ 80%" },
      { label: "Send for human review when", value: "50–80%" },
      { label: "Reject when below", value: "50%" },
    ],
    technical: {
      trigger: "artifact produced → CritiqueWorker.critique()",
      produces: ["critique.completed.v1"],
      sourceFile: "apps/worker-critique/src/critique-worker.ts",
    },
  },
  {
    id: "learning",
    name: "Learning Director",
    glyph: "🧠",
    category: "Quality",
    motion: "All motions",
    tagline:
      "The learning loop — turns your approvals and edits into a smarter playbook over time.",
    status: "active",
    wakeUp: {
      kind: "event",
      summary:
        "Wakes every time you approve, edit or reject something, and every time the Quality Reviewer scores a draft. This is how the system gets better the more you use it.",
      trigger: "Every time you approve, edit or reject something",
    },
    consumes: ["Your approval decisions and the quality reviews"],
    produces: [
      "Proposed playbook improvements (shipped only with your consent)",
    ],
    llm: { used: false, fallback: "pattern detection across your decisions" },
    howItWorks: [
      "Watches how you respond to drafts. A rejection or heavy edit is a strong signal; an approve-with-no-edits confirms the current approach works.",
      "Detects patterns (e.g. 'softer CTAs get approved without edits') and proposes a playbook change.",
      "When you accept a change, future drafts follow the improved playbook — so they need fewer edits next time.",
      "Playbook changes always require your consent before they take effect.",
    ],
    pipeline: "Closes the loop",
    knobs: [
      { label: "Rejected work", value: "strong signal to learn from" },
      { label: "Heavily edited (15%+)", value: "improvable pattern" },
      { label: "Approved with no edits", value: "confirms current approach" },
    ],
    technical: {
      trigger: "learning.signal.v1 + critique.completed.v1",
      queueGroup: "worker-learning",
      produces: [
        "learning.candidate.synthesized.v1",
        "learning.playbook.updated.v1",
      ],
      sourceFile: "apps/worker-learning/src/learning-worker.ts",
    },
  },

  // ─── Outbound / Warmth ───────────────────────────────────────────────────
  {
    id: "warmth",
    name: "Warmth Builder (LinkedIn warm-up)",
    glyph: "🔥",
    category: "Outbound",
    motion: "Warm Outbound",
    tagline:
      "Tracks relationship warmth across LinkedIn, email and calls — and blocks cold outreach.",
    status: "active",
    wakeUp: {
      kind: "call",
      summary:
        "Wakes whenever a prospect engages — a LinkedIn view, like or comment, an email open, a reply, or a meeting — and recalculates how warm the relationship is. It's the gate that stands in front of all cold outreach.",
      trigger: "Whenever a prospect engages (LinkedIn, email, call, meeting)",
    },
    consumes: ["Engagement across LinkedIn, email, content and meetings"],
    produces: ["A warmth score, and a go / no-go decision on outreach"],
    llm: { used: false, fallback: "engagement scoring that fades over time" },
    howItWorks: [
      "LinkedIn warm-up: as the persona views, likes and comments on a prospect's content, each touch adds warmth — a comment counts more than a like, which counts more than a view.",
      "Email and calls add warmth too — a reply counts a lot, a meeting counts most.",
      "Warmth fades over ~2 weeks, so the score reflects recent engagement, not ancient history.",
      "Outreach is blocked until a prospect is warm enough — so reps only reach people who are actually engaged, across every channel, as one score.",
    ],
    knobs: [
      { label: "A meeting", value: "counts most" },
      { label: "A reply / content read", value: "counts a lot" },
      {
        label: "LinkedIn comment / like / view",
        value: "counts progressively less",
      },
      { label: "Warmth fades over", value: "~2 weeks" },
    ],
    technical: {
      trigger: "touch recorded → WarmthWorker",
      produces: ["warmth.evaluated.v1"],
      sourceFile: "apps/worker-warmth/src/warmth-worker.ts",
    },
  },
  {
    id: "warm-outbound-researcher",
    name: "Warm Outbound Researcher",
    glyph: "🎯",
    category: "Outbound",
    motion: "Warm Outbound",
    tagline:
      "When a prospect engages, it drafts the next message — grounded in the conversation and approved talking points.",
    status: "planned",
    wakeUp: {
      kind: "event",
      summary:
        "Wakes the moment a prospect replies on email or after a call. (The routing is already in place; the agent is the next build.)",
      trigger: "The moment a prospect replies",
    },
    consumes: [
      "A prospect reply, the conversation history, and your approved messaging",
    ],
    produces: ["A ready-to-review follow-up draft"],
    llm: {
      used: true,
      model: "AI-drafted follow-up",
      fallback: "template draft",
    },
    howItWorks: [
      "Triggered the instant a prospect replies on email or after a call.",
      "Pulls the conversation history, the deal context, and your compliance-approved talking points.",
      "Drafts the next message and sends it to the Approval Queue — never auto-sends regulated insurance content.",
      "Once you approve, it's queued into your email or calling tool.",
    ],
    technical: {
      trigger: "signal.routed.v1 (target = warm_outbound_researcher)",
      sourceFile: "planned",
    },
  },

  // ─── Lifecycle ─────────────────────────────────────────────────────────────
  {
    id: "lifecycle-expansion",
    name: "Lifecycle / Expansion Agent",
    glyph: "📈",
    category: "Lifecycle",
    motion: "Retention · Expansion",
    tagline:
      "Spots expansion opportunities and early churn warnings across client portfolios.",
    status: "planned",
    wakeUp: {
      kind: "event",
      summary:
        "Wakes when a client's portfolio grows, a key contact changes, or an account goes quiet.",
      trigger: "When an account grows, a contact changes, or activity drops",
    },
    consumes: ["Portfolio growth, personnel changes, and engagement trends"],
    produces: [
      "Expansion plays and early churn-risk alerts for the Success team",
    ],
    llm: { used: true, model: "AI-drafted play", fallback: "rule-based play" },
    howItWorks: [
      "Notices when a client adds properties or units (e.g. Madison +1,200 units) and drafts an expansion play.",
      "Notices when a champion leaves and flags re-engagement.",
      "Notices when engagement drops vs. normal — an early churn warning, months before renewal.",
    ],
    technical: {
      trigger: "account.expanded · champion.moved",
      sourceFile: "planned",
    },
  },
  {
    id: "community",
    name: "Community Agent",
    glyph: "💬",
    category: "Lifecycle",
    motion: "Community",
    tagline:
      "Monitors industry communities and drafts helpful, on-brand replies for approval.",
    status: "planned",
    wakeUp: {
      kind: "event",
      summary:
        "Wakes when your brand or topic comes up in an industry community.",
      trigger: "When your brand or topic comes up in a community",
    },
    consumes: ["Mentions and discussions in industry communities"],
    produces: ["A reply draft for your approval"],
    llm: { used: true, model: "AI-drafted reply", fallback: "template reply" },
    howItWorks: [
      "Monitors industry communities for relevant discussions.",
      "Drafts a helpful, non-salesy reply grounded in your approved talking points.",
      "Sends it for approval before anything is posted.",
    ],
    technical: {
      trigger: "community.mention · competitor.discussed",
      sourceFile: "planned",
    },
  },

  // ─── Infrastructure ────────────────────────────────────────────────────────
  {
    id: "outbox-publisher",
    name: "System Heartbeat",
    glyph: "⏱",
    category: "Infrastructure",
    motion: "Platform",
    tagline:
      "The heartbeat that keeps everything moving — it's how every agent wakes up.",
    status: "active",
    wakeUp: {
      kind: "infra",
      summary:
        "This is the heartbeat. Every second it picks up new work and wakes the right agent to handle it.",
      trigger: "Continuously — about once a second",
    },
    consumes: ["New work queued by any part of the system"],
    produces: ["Wakes the right agent to act"],
    howItWorks: [
      "Whenever any part of the system creates work, it's recorded reliably.",
      "About once a second (or instantly), the heartbeat picks up that work.",
      "It wakes the right agent, which then does its job.",
      "This steady pulse is what makes the whole system feel alive and responsive.",
    ],
    knobs: [
      { label: "Checks for new work", value: "about every second" },
      { label: "Wakes agents", value: "instantly" },
    ],
    technical: {
      trigger: "1s cycle + Postgres LISTEN/NOTIFY",
      produces: ["publishes to NATS t.{tenant}.{event}"],
      sourceFile: "apps/worker-outbox-publisher/src/runner.ts",
    },
  },
];

export const AGENT_CATEGORIES = [
  "Intelligence",
  "Content",
  "Quality",
  "Outbound",
  "Lifecycle",
  "Infrastructure",
] as const;

export function getAgent(id: string): AgentDef | undefined {
  return AGENTS.find((a) => a.id === id);
}

export const STATUS_META: Record<
  AgentStatus,
  { label: string; dot: string; badge: "approved" | "neutral" | "pending" }
> = {
  active: { label: "Live", dot: "bg-green-500", badge: "approved" },
  idle: { label: "Idle", dot: "bg-gray-400", badge: "neutral" },
  planned: { label: "Planned", dot: "bg-amber-500", badge: "pending" },
};
