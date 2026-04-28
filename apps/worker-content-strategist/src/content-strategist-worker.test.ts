import {
  contentBriefV1Schema,
  contentOpportunityV1Schema,
  intelBriefV1Schema,
} from "@growthos/core";
import { InMemoryOutboxRepository } from "@growthos/db";
import { describe, expect, it, vi } from "vitest";
import {
  ContentStrategistWorker,
  type EventPublisher,
  expandOpportunity,
  generateContentBrief,
} from "./content-strategist-worker.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT_ID = "00000000-0000-4000-8000-000000000003";
const BRIEF_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OPPORTUNITY_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const makeIntelBrief = (overrides: Record<string, unknown> = {}) =>
  intelBriefV1Schema.parse({
    schema_version: "intel_brief.v1",
    tenant_id: TENANT_ID,
    brief_id: BRIEF_ID,
    generated_at: "2026-04-28T00:00:00.000Z",
    period: { from: "2026-04-01", to: "2026-04-28" },
    competitive_signals: [],
    community_signals: [],
    content_opportunities: [
      {
        opportunity_id: OPPORTUNITY_ID,
        title: "Why PLG outpaces traditional SaaS sales in 2026",
        rationale: "Baseline rationale from intelligence scan.",
        urgency: "this_week",
        motion_fit: ["plg"],
        score: 1.2,
      },
    ],
    recommended_focus: "Focus on PLG motion.",
    ...overrides,
  });

// ---------------------------------------------------------------------------
// expandOpportunity
// ---------------------------------------------------------------------------

const firstOpp = (brief: ReturnType<typeof makeIntelBrief>) => {
  const ref = brief.content_opportunities[0];
  if (!ref) throw new Error("fixture has no opportunities");
  return ref;
};

describe("expandOpportunity", () => {
  it("produces a schema-valid ContentOpportunityV1", () => {
    const brief = makeIntelBrief();
    const result = expandOpportunity(brief, firstOpp(brief));
    expect(() => contentOpportunityV1Schema.parse(result)).not.toThrow();
  });

  it("preserves opportunity_id, source_brief_id, title from ref/brief", () => {
    const brief = makeIntelBrief();
    const ref = firstOpp(brief);
    const result = expandOpportunity(brief, ref);
    expect(result.opportunity_id).toBe(OPPORTUNITY_ID);
    expect(result.source_brief_id).toBe(BRIEF_ID);
    expect(result.title).toBe(ref.title);
  });

  it("sets content_format=long_form_blog for plg motion", () => {
    const brief = makeIntelBrief();
    const result = expandOpportunity(brief, firstOpp(brief));
    expect(result.content_format).toBe("long_form_blog");
  });

  it("sets content_format=email for outbound_multichannel motion", () => {
    const brief = makeIntelBrief();
    const ref = {
      ...firstOpp(brief),
      motion_fit: ["outbound_multichannel" as const],
    };
    const result = expandOpportunity(brief, ref);
    expect(result.content_format).toBe("email");
  });

  it("always includes at least one evidence item", () => {
    const brief = makeIntelBrief();
    const result = expandOpportunity(brief, firstOpp(brief));
    expect(result.evidence.length).toBeGreaterThanOrEqual(1);
  });

  it("hook is at least 10 characters", () => {
    const brief = makeIntelBrief();
    const result = expandOpportunity(brief, firstOpp(brief));
    expect(result.hook.length).toBeGreaterThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// generateContentBrief
// ---------------------------------------------------------------------------

describe("generateContentBrief", () => {
  const makeOpportunity = () => {
    const brief = makeIntelBrief();
    return expandOpportunity(brief, firstOpp(brief));
  };

  it("produces a schema-valid ContentBriefV1", () => {
    const opp = makeOpportunity();
    const brief = generateContentBrief(opp);
    expect(() => contentBriefV1Schema.parse(brief)).not.toThrow();
  });

  it("outline has at least 4 sections", () => {
    const opp = makeOpportunity();
    const brief = generateContentBrief(opp);
    expect(brief.outline.length).toBeGreaterThanOrEqual(4);
  });

  it("each outline section has at least one key_point", () => {
    const opp = makeOpportunity();
    const brief = generateContentBrief(opp);
    for (const section of brief.outline) {
      expect(section.key_points.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("links opportunity_id to the source opportunity", () => {
    const opp = makeOpportunity();
    const brief = generateContentBrief(opp);
    expect(brief.opportunity_id).toBe(opp.opportunity_id);
  });

  it("confidence_score is bounded [0, 1]", () => {
    const opp = makeOpportunity();
    const brief = generateContentBrief(opp);
    expect(brief.confidence_score).toBeGreaterThanOrEqual(0);
    expect(brief.confidence_score).toBeLessThanOrEqual(1);
  });

  it("includes plg hint in tone_notes for plg motion", () => {
    const opp = makeOpportunity(); // plg motion
    const brief = generateContentBrief(opp);
    expect(brief.tone_notes).toContain("product screenshots");
  });

  it("estimated_word_count is positive", () => {
    const opp = makeOpportunity();
    const brief = generateContentBrief(opp);
    expect(brief.estimated_word_count).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// ContentStrategistWorker integration
// ---------------------------------------------------------------------------

const makeWorker = (publishFn = vi.fn(async () => undefined)) => {
  const outboxRepository = new InMemoryOutboxRepository();
  const eventPublisher: EventPublisher = { publish: publishFn };
  const worker = new ContentStrategistWorker({
    outboxRepository,
    eventPublisher,
  });
  return { worker, outboxRepository, eventPublisher };
};

describe("ContentStrategistWorker", () => {
  it("emits content_opportunity.v1 + content_brief.v1 for each opportunity", async () => {
    const publishFn = vi.fn(async () => undefined);
    const { worker, outboxRepository } = makeWorker(publishFn);

    const result = await worker.processBrief(makeIntelBrief());

    expect(result.opportunities).toHaveLength(1);
    expect(result.briefs).toHaveLength(1);

    const events = await outboxRepository.listUnconsumed(TENANT_ID, 10);
    const eventTypes = events.map((e) => e.eventType);
    expect(eventTypes).toContain("content_opportunity.v1");
    expect(eventTypes).toContain("content_brief.v1");

    // 2 NATS publishes per opportunity
    expect(publishFn).toHaveBeenCalledTimes(2);
    expect(publishFn).toHaveBeenCalledWith(
      `t.${TENANT_ID}.content_opportunity.v1`,
      expect.objectContaining({ schema_version: "content_opportunity.v1" }),
    );
    expect(publishFn).toHaveBeenCalledWith(
      `t.${TENANT_ID}.content_brief.v1`,
      expect.objectContaining({ schema_version: "content_brief.v1" }),
    );
  });

  it("is idempotent: replayed brief produces no new outbox entries", async () => {
    const { worker, outboxRepository } = makeWorker();
    const brief = makeIntelBrief();

    await worker.processBrief(brief);
    await worker.processBrief(brief);

    const events = await outboxRepository.listUnconsumed(TENANT_ID, 20);
    expect(events).toHaveLength(2); // 1 opportunity + 1 brief, no duplicates
  });

  it("handles a brief with multiple opportunities", async () => {
    const { worker, outboxRepository } = makeWorker();
    const multiOpBrief = intelBriefV1Schema.parse({
      schema_version: "intel_brief.v1",
      tenant_id: TENANT_ID,
      brief_id: BRIEF_ID,
      generated_at: "2026-04-28T00:00:00.000Z",
      period: { from: "2026-04-01", to: "2026-04-28" },
      competitive_signals: [],
      community_signals: [],
      content_opportunities: [
        {
          opportunity_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          title: "Opportunity One",
          rationale: "Rationale A",
          urgency: "this_week",
          motion_fit: ["plg"],
          score: 1.0,
        },
        {
          opportunity_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          title: "Opportunity Two",
          rationale: "Rationale B",
          urgency: "this_month",
          motion_fit: ["inbound_content"],
          score: 0.8,
        },
      ],
      recommended_focus: "Split motion.",
    });

    const result = await worker.processBrief(multiOpBrief);
    expect(result.opportunities).toHaveLength(2);
    expect(result.briefs).toHaveLength(2);

    const events = await outboxRepository.listUnconsumed(TENANT_ID, 20);
    expect(events).toHaveLength(4); // 2x (opportunity + brief)
  });

  it("rejects invalid input", async () => {
    const { worker } = makeWorker();
    await expect(
      worker.processBrief({ not: "an_intel_brief" }),
    ).rejects.toThrow();
  });

  it("generates unique brief_ids for different opportunities in the same run", async () => {
    const { worker } = makeWorker();
    const multiOpBrief = intelBriefV1Schema.parse({
      schema_version: "intel_brief.v1",
      tenant_id: TENANT_ID,
      brief_id: BRIEF_ID,
      generated_at: "2026-04-28T00:00:00.000Z",
      period: { from: "2026-04-01", to: "2026-04-28" },
      competitive_signals: [],
      community_signals: [],
      content_opportunities: [
        {
          opportunity_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          title: "Opp Alpha",
          rationale: "R",
          urgency: "now",
          motion_fit: ["plg"],
          score: 1.5,
        },
        {
          opportunity_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
          title: "Opp Beta",
          rationale: "R",
          urgency: "now",
          motion_fit: ["abm"],
          score: 1.5,
        },
      ],
      recommended_focus: "Both.",
    });

    const result = await worker.processBrief(multiOpBrief);
    const briefIds = result.briefs.map((b) => b.brief_id);
    expect(new Set(briefIds).size).toBe(2); // all unique
  });
});
