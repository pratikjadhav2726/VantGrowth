/**
 * Motion catalog — maps the canonical 8 motion labels to plain names, the
 * action each one drives, and the agents it activates. Scores + the active
 * stack come live from /v1/motion; this supplies the human-readable framing.
 */

export interface MotionMeta {
  name: string;
  glyph: string;
  drives: string; // "for what action"
  agents: string[]; // agent ids this motion activates (link into the roster)
  why: string; // why it scores the way it does, in Insurance company's context
  inputs: string; // the GTM signals that move this motion's score
}

export const MOTION_CATALOG: Record<string, MotionMeta> = {
  outbound_multichannel: {
    name: "Warm Outbound",
    glyph: "🎯",
    drives: "Warm email + call + LinkedIn to named PMC accounts",
    agents: ["warm-outbound-researcher", "warmth"],
    why: "Scores high because PMC deals are large and sales cycles are long and multi-stakeholder — exactly where targeted, warm, multi-touch outreach pays off.",
    inputs: "Deal size · sales-cycle length · engagement data · budget",
  },
  lifecycle_expansion: {
    name: "Lifecycle & Expansion",
    glyph: "📈",
    drives: "Retention, expansion plays, and churn early-warning",
    agents: ["lifecycle-expansion"],
    why: "Scores high on the rich activity and renewal data you already capture, plus a strong expansion lever inside existing PMC portfolios (more properties, more units).",
    inputs: "Engagement data · trial/usage depth · product fit · budget",
  },
  abm: {
    name: "Account-Based (ABM)",
    glyph: "🏢",
    drives: "Targeted plays against a finite list of large operators",
    agents: ["intel-director", "warm-outbound-researcher"],
    why: "Scores high on high deal size plus a long cycle — PMCs are a finite, named list of large operators, which is the ideal shape for account-based plays.",
    inputs: "Deal size · sales-cycle length",
  },
  community_engagement: {
    name: "Community",
    glyph: "💬",
    drives: "Helpful, on-brand replies in industry communities",
    agents: ["community"],
    why: "Moderate — there are active multifamily communities to engage, but their density is lower than your core outbound and lifecycle channels.",
    inputs: "Community density · content capacity",
  },
  inbound_content: {
    name: "Inbound Content",
    glyph: "✍",
    drives: "Content engine: intel briefs → plans → drafts",
    agents: ["intel-director", "content-strategist", "blog-draft"],
    why: "Moderate — embedded-insurance search demand is modest today, which caps how much inbound content can pull on its own.",
    inputs: "Search demand · content capacity · engagement data",
  },
  partners: {
    name: "Partners",
    glyph: "🤝",
    drives: "Channel / partner GTM",
    agents: [],
    why: "Moderate — high deal size helps, but partner density and integration complexity are mid-range right now.",
    inputs: "Deal size · product complexity · community density",
  },
  paid: {
    name: "Paid Acquisition",
    glyph: "💸",
    drives: "Paid campaigns",
    agents: [],
    why: "Low — limited budget-readiness and modest search demand make paid acquisition inefficient at this stage.",
    inputs: "Budget · search demand · trialability",
  },
  plg: {
    name: "Product-Led Growth",
    glyph: "🚀",
    drives: "Self-serve activation and conversion",
    agents: [],
    why: "Low — the product is integration-led (rolled out per property), not self-serve, so trialability is limited.",
    inputs: "Trialability · engagement data",
  },
};

export type MotionTier = "Primary" | "Secondary" | "Observe" | "Off";

export const TIER_META: Record<MotionTier, { badge: "approved" | "processing" | "neutral" | "rejected"; bar: string }> = {
  Primary: { badge: "approved", bar: "bg-green-500" },
  Secondary: { badge: "processing", bar: "bg-blue-500" },
  Observe: { badge: "neutral", bar: "bg-amber-400" },
  Off: { badge: "rejected", bar: "bg-gray-300" },
};

export function motionDisplay(label: string): MotionMeta {
  return (
    MOTION_CATALOG[label] ?? {
      name: label,
      glyph: "•",
      drives: "—",
      agents: [],
    }
  );
}
