import { describe, expect, it } from "vitest";
import {
  HANDOFF_CONTRACT_SCHEMAS,
  blogDraftV1Schema,
  contentBriefV1Schema,
  contentOpportunityV1Schema,
  intelBriefV1Schema,
  isHandoffContractVersion,
  parseHandoffContract,
} from "./handoff-contracts.js";

// ---------------------------------------------------------------------------
// Fixture factories — minimal valid payloads
// ---------------------------------------------------------------------------

const NOW = new Date().toISOString();
const TENANT = "00000000-0000-0000-0001-000000000001";
const ID1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ID2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ID3 = "cccccccc-cccc-cccc-cccc-cccccccccccc";

const makeIntelBrief = (overrides = {}) => ({
  schema_version: "intel_brief.v1" as const,
  tenant_id: TENANT,
  brief_id: ID1,
  generated_at: NOW,
  period: { from: "2025-01-01", to: "2025-01-07" },
  competitive_signals: [
    {
      competitor: "AcmeCRM",
      signal_type: "pricing_change" as const,
      summary: "AcmeCRM dropped its entry plan from $99 to $49/mo.",
      source_url: "https://acmecrm.com/pricing",
      confidence: 0.95,
      is_persisting: false,
    },
  ],
  community_signals: [
    {
      platform: "reddit",
      signal_type: "question_spike" as const,
      summary:
        "Multiple founders asking how to run PLG without engineering bandwidth.",
      sample_posts: ["Post A", "Post B"],
      confidence: 0.8,
      motion_fit: ["inbound_content" as const, "plg" as const],
    },
  ],
  content_opportunities: [
    {
      opportunity_id: ID2,
      title: "PLG without engineers: the founder playbook",
      rationale:
        "High community demand, no competitor content targeting founders.",
      urgency: "this_week" as const,
      motion_fit: ["inbound_content" as const, "plg" as const],
      score: 1.4,
    },
  ],
  recommended_focus: "PLG without engineers: the founder playbook",
  ...overrides,
});

const makeContentOpportunity = (overrides = {}) => ({
  schema_version: "content_opportunity.v1" as const,
  tenant_id: TENANT,
  opportunity_id: ID2,
  source_brief_id: ID1,
  title: "PLG without engineers: the founder playbook",
  hook: "You can ship a viral-loop activation flow in an afternoon without touching your codebase.",
  rationale:
    "Rising community demand + no competitor content targeting non-technical founders.",
  target_audience: ["non-technical founders", "solo GTM leads"],
  motion_fit: ["inbound_content" as const, "plg" as const],
  urgency: "this_week" as const,
  content_format: "long_form_blog" as const,
  evidence: [
    {
      type: "community_pain" as const,
      description: "Reddit thread: 47 upvotes asking for no-code PLG guidance",
      source_url: "https://reddit.com/r/SaaS/comments/example",
    },
  ],
  score: 1.4,
  created_at: NOW,
  ...overrides,
});

const makeContentBrief = (overrides = {}) => ({
  schema_version: "content_brief.v1" as const,
  tenant_id: TENANT,
  brief_id: ID3,
  opportunity_id: ID2,
  generated_at: NOW,
  title: "PLG without engineers: the founder playbook",
  hook: "You can ship a viral-loop activation flow in an afternoon without touching your codebase.",
  target_audience: ["non-technical founders"],
  search_intent: "informational" as const,
  primary_keyword: "PLG without engineering",
  secondary_keywords: [
    "founder-led growth tactics",
    "no-code product-led growth",
  ],
  outline: [
    {
      section_title: "What PLG actually requires",
      key_points: ["activation event", "friction audit"],
      word_count_target: 300,
    },
    {
      section_title: "The 3 tools that handle the engineering",
      key_points: ["Appcues", "Chameleon", "PostHog"],
      word_count_target: 400,
    },
    {
      section_title: "Our 14-day activation playbook",
      key_points: ["day 1: instrument", "day 7: experiment", "day 14: iterate"],
    },
    {
      section_title: "What to measure",
      key_points: ["time-to-value metric", "activation cohort chart"],
      word_count_target: 250,
    },
  ],
  tone_notes: "Confident, practical, data-backed. No hedging. First person.",
  claims_to_avoid: ["best-in-class", "guaranteed results"],
  internal_links_suggested: [
    { anchor: "motion scoring", target_url: "/blog/motion-engine-explained" },
  ],
  cta: "Run your free motion score — takes 3 minutes",
  estimated_word_count: 1200,
  motion_fit: ["inbound_content" as const],
  confidence_score: 0.82,
  ...overrides,
});

const makeBlogDraft = (overrides = {}) => ({
  schema_version: "blog_draft.v1" as const,
  tenant_id: TENANT,
  draft_id: ID3,
  brief_id: ID3,
  generated_at: NOW,
  iteration: 1,
  title: "PLG without engineers: the founder playbook",
  meta_description:
    "Ship a viral-loop activation flow in an afternoon. The no-code PLG guide for non-technical founders.",
  body_markdown: `## What PLG actually requires\n\nPLG is not a product feature. It's an activation contract...\n\n${"Lorem ipsum dolor sit amet. ".repeat(20)}\n\n## The 3 tools\n\nYou don't need a full-stack engineer for this.\n\n${"Consectetur adipiscing elit. ".repeat(20)}\n\n## Our playbook\n\nDay 1: instrument the activation event.\n\n${"Sed do eiusmod tempor. ".repeat(20)}\n\n## What to measure\n\nTime-to-value is the only metric that matters in week one.\n\n${"Ut labore et dolore. ".repeat(20)}`,
  word_count: 650,
  reading_time_minutes: 3,
  estimated_claims: [
    {
      text: "trial-to-paid jumped from 6% to 19%",
      type: "stat" as const,
      requires_verification: true,
    },
  ],
  quality_indicators: {
    flesch_score: 68,
    grade_level: 9,
    has_cta: true,
    has_internal_links: true,
    heading_count: 4,
  },
  status: "draft" as const,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("intel_brief.v1", () => {
  it("parses a valid brief", () => {
    const result = intelBriefV1Schema.safeParse(makeIntelBrief());
    expect(result.success).toBe(true);
  });

  it("requires at least 1 content_opportunity", () => {
    const result = intelBriefV1Schema.safeParse(
      makeIntelBrief({ content_opportunities: [] }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects invalid period date format", () => {
    const result = intelBriefV1Schema.safeParse(
      makeIntelBrief({ period: { from: "01-01-2025", to: "01-07-2025" } }),
    );
    expect(result.success).toBe(false);
  });

  it("confidence out of [0,1] fails", () => {
    const brief = makeIntelBrief();
    const sig = brief.competitive_signals[0];
    if (sig) sig.confidence = 1.5;
    expect(intelBriefV1Schema.safeParse(brief).success).toBe(false);
  });
});

describe("content_opportunity.v1", () => {
  it("parses a valid opportunity", () => {
    const result = contentOpportunityV1Schema.safeParse(
      makeContentOpportunity(),
    );
    expect(result.success).toBe(true);
  });

  it("requires at least 1 evidence entry", () => {
    const result = contentOpportunityV1Schema.safeParse(
      makeContentOpportunity({ evidence: [] }),
    );
    expect(result.success).toBe(false);
  });

  it("requires at least 1 motion_fit entry", () => {
    const result = contentOpportunityV1Schema.safeParse(
      makeContentOpportunity({ motion_fit: [] }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects unknown content_format", () => {
    const result = contentOpportunityV1Schema.safeParse(
      makeContentOpportunity({ content_format: "infographic" }),
    );
    expect(result.success).toBe(false);
  });
});

describe("content_brief.v1", () => {
  it("parses a valid brief", () => {
    const result = contentBriefV1Schema.safeParse(makeContentBrief());
    expect(result.success).toBe(true);
  });

  it("requires at least 4 outline sections", () => {
    const result = contentBriefV1Schema.safeParse(
      makeContentBrief({ outline: makeContentBrief().outline.slice(0, 3) }),
    );
    expect(result.success).toBe(false);
  });

  it("confidence_score must be within [0, 1]", () => {
    expect(
      contentBriefV1Schema.safeParse(
        makeContentBrief({ confidence_score: 1.1 }),
      ).success,
    ).toBe(false);
    expect(
      contentBriefV1Schema.safeParse(
        makeContentBrief({ confidence_score: -0.1 }),
      ).success,
    ).toBe(false);
    expect(
      contentBriefV1Schema.safeParse(
        makeContentBrief({ confidence_score: 0.5 }),
      ).success,
    ).toBe(true);
  });

  it("defaults empty optional arrays", () => {
    const brief = makeContentBrief();
    const {
      secondary_keywords,
      claims_to_avoid,
      internal_links_suggested,
      ...rest
    } = brief;
    void secondary_keywords;
    void claims_to_avoid;
    void internal_links_suggested;
    const result = contentBriefV1Schema.safeParse(rest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.secondary_keywords).toEqual([]);
      expect(result.data.claims_to_avoid).toEqual([]);
      expect(result.data.internal_links_suggested).toEqual([]);
    }
  });
});

describe("blog_draft.v1", () => {
  it("parses a valid draft", () => {
    const result = blogDraftV1Schema.safeParse(makeBlogDraft());
    expect(result.success).toBe(true);
  });

  it("body_markdown must be at least 100 chars", () => {
    const result = blogDraftV1Schema.safeParse(
      makeBlogDraft({ body_markdown: "short" }),
    );
    expect(result.success).toBe(false);
  });

  it("meta_description cannot exceed 160 chars", () => {
    const result = blogDraftV1Schema.safeParse(
      makeBlogDraft({ meta_description: "a".repeat(161) }),
    );
    expect(result.success).toBe(false);
  });

  it("defaults status to 'draft'", () => {
    const { status, ...rest } = makeBlogDraft();
    void status;
    const result = blogDraftV1Schema.safeParse(rest);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.status).toBe("draft");
  });
});

describe("schema registry + parseHandoffContract", () => {
  it("HANDOFF_CONTRACT_SCHEMAS has all 4 versions", () => {
    expect(Object.keys(HANDOFF_CONTRACT_SCHEMAS)).toEqual([
      "intel_brief.v1",
      "content_opportunity.v1",
      "content_brief.v1",
      "blog_draft.v1",
    ]);
  });

  it("isHandoffContractVersion recognises known versions", () => {
    expect(isHandoffContractVersion("intel_brief.v1")).toBe(true);
    expect(isHandoffContractVersion("blog_draft.v1")).toBe(true);
    expect(isHandoffContractVersion("unknown.v99")).toBe(false);
  });

  it("parseHandoffContract dispatches intel_brief.v1 correctly", () => {
    const result = parseHandoffContract(makeIntelBrief());
    expect(result.schema_version).toBe("intel_brief.v1");
  });

  it("parseHandoffContract dispatches blog_draft.v1 correctly", () => {
    const result = parseHandoffContract(makeBlogDraft());
    expect(result.schema_version).toBe("blog_draft.v1");
  });

  it("parseHandoffContract throws on missing schema_version", () => {
    expect(() => parseHandoffContract({ tenant_id: TENANT })).toThrow(
      "missing schema_version",
    );
  });

  it("parseHandoffContract throws on unknown schema_version", () => {
    expect(() =>
      parseHandoffContract({
        schema_version: "unknown.v99",
        tenant_id: TENANT,
      }),
    ).toThrow("Unknown handoff contract version");
  });
});
