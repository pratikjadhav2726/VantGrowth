import { blogDraftV1Schema, contentBriefV1Schema } from "@growthos/core";
import { InMemoryOutboxRepository } from "@growthos/db";
import { StubLlmCallRunner } from "@growthos/llm-harness";
import { describe, expect, it, vi } from "vitest";
import {
  BlogDraftWorker,
  type EventPublisher,
  generateBlogDraft,
  generateLlmBlogDraft,
} from "./blog-draft-worker.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT_ID = "00000000-0000-4000-8000-000000000005";
const BRIEF_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OPPORTUNITY_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const makeBrief = (overrides: Record<string, unknown> = {}) =>
  contentBriefV1Schema.parse({
    schema_version: "content_brief.v1",
    tenant_id: TENANT_ID,
    brief_id: BRIEF_ID,
    opportunity_id: OPPORTUNITY_ID,
    generated_at: "2026-04-28T00:00:00.000Z",
    title: "Why PLG Beats Traditional SaaS Sales in 2026",
    hook: "Product-led growth is no longer optional — here is why founders are making the shift now.",
    target_audience: ["B2B founders", "growth practitioners"],
    search_intent: "informational",
    primary_keyword: "plg-saas-sales",
    secondary_keywords: ["product-led growth", "growth strategy"],
    outline: [
      {
        section_title: "Introduction & Context",
        key_points: ["Why PLG matters now", "The cost of ignoring PLG"],
        word_count_target: 200,
      },
      {
        section_title: "Core Framework",
        key_points: [
          "Define PLG in one sentence",
          "How it maps to inbound motion",
          "Step-by-step approach",
        ],
        word_count_target: 400,
      },
      {
        section_title: "Evidence & Examples",
        key_points: [
          "Slack and Figma growth metrics",
          "Counter-intuitive insight",
          "Community signal quote",
        ],
        word_count_target: 350,
      },
      {
        section_title: "Implementation Guide",
        key_points: [
          "This week action",
          "This month initiative",
          "Success metric",
        ],
        word_count_target: 300,
      },
      {
        section_title: "Conclusion & CTA",
        key_points: ["Restate the core insight", "Invite reader engagement"],
        word_count_target: 150,
      },
    ],
    tone_notes: "Founder-voice. First person preferred.",
    claims_to_avoid: ["market leader", "10x results"],
    internal_links_suggested: [],
    cta: "Start your PLG motion — book a strategy session.",
    estimated_word_count: 1400,
    motion_fit: ["plg"],
    confidence_score: 0.75,
    ...overrides,
  });

const makeWorker = (publishFn = vi.fn(async () => undefined)) => {
  const outboxRepository = new InMemoryOutboxRepository();
  const eventPublisher: EventPublisher = { publish: publishFn };
  const worker = new BlogDraftWorker({ outboxRepository, eventPublisher });
  return { worker, outboxRepository };
};

// ---------------------------------------------------------------------------
// generateBlogDraft
// ---------------------------------------------------------------------------

describe("generateBlogDraft", () => {
  it("produces a schema-valid BlogDraftV1", () => {
    const brief = makeBrief();
    const draft = generateBlogDraft(brief);
    expect(() => blogDraftV1Schema.parse(draft)).not.toThrow();
  });

  it("links draft to source brief via brief_id", () => {
    const draft = generateBlogDraft(makeBrief());
    expect(draft.brief_id).toBe(BRIEF_ID);
    expect(draft.tenant_id).toBe(TENANT_ID);
  });

  it("body_markdown contains all section titles as headings", () => {
    const brief = makeBrief();
    const draft = generateBlogDraft(brief);
    for (const section of brief.outline) {
      expect(draft.body_markdown).toContain(`## ${section.section_title}`);
    }
  });

  it("body_markdown meets min(100) length threshold", () => {
    const draft = generateBlogDraft(makeBrief());
    expect(draft.body_markdown.length).toBeGreaterThanOrEqual(100);
  });

  it("word_count is positive and consistent with body", () => {
    const draft = generateBlogDraft(makeBrief());
    expect(draft.word_count).toBeGreaterThan(0);
    const manualCount = draft.body_markdown
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0).length;
    expect(draft.word_count).toBe(manualCount);
  });

  it("reading_time_minutes is at least 1", () => {
    const draft = generateBlogDraft(makeBrief());
    expect(draft.reading_time_minutes).toBeGreaterThanOrEqual(1);
  });

  it("meta_description is at most 160 characters", () => {
    const draft = generateBlogDraft(makeBrief());
    expect(draft.meta_description.length).toBeLessThanOrEqual(160);
  });

  it("heading_count reflects actual markdown headings in body", () => {
    const draft = generateBlogDraft(makeBrief());
    const headings = (draft.body_markdown.match(/^#{1,6}\s+\S/gm) ?? []).length;
    expect(draft.quality_indicators.heading_count).toBe(headings);
  });

  it("has_cta is true when brief CTA contains a recognised phrase", () => {
    const draft = generateBlogDraft(makeBrief());
    expect(draft.quality_indicators.has_cta).toBe(true);
  });

  it("has_internal_links is false when brief has no internal link suggestions", () => {
    const draft = generateBlogDraft(
      makeBrief({ internal_links_suggested: [] }),
    );
    expect(draft.quality_indicators.has_internal_links).toBe(false);
  });

  it("has_internal_links is true when brief has internal link suggestions", () => {
    const draft = generateBlogDraft(
      makeBrief({
        internal_links_suggested: [
          { anchor: "PLG guide", target_url: "/guide/plg" },
        ],
      }),
    );
    expect(draft.quality_indicators.has_internal_links).toBe(true);
  });

  it("flesch_score and grade_level are null in Phase 1", () => {
    const draft = generateBlogDraft(makeBrief());
    expect(draft.quality_indicators.flesch_score).toBeNull();
    expect(draft.quality_indicators.grade_level).toBeNull();
  });

  it("status defaults to draft", () => {
    const draft = generateBlogDraft(makeBrief());
    expect(draft.status).toBe("draft");
  });

  it("draft_id is a unique UUID on each call", () => {
    const brief = makeBrief();
    const d1 = generateBlogDraft(brief);
    const d2 = generateBlogDraft(brief);
    expect(d1.draft_id).not.toBe(d2.draft_id);
  });
});

// ---------------------------------------------------------------------------
// BlogDraftWorker integration
// ---------------------------------------------------------------------------

describe("BlogDraftWorker", () => {
  it("emits blog_draft.v1 to outbox and tenant-scoped NATS subject", async () => {
    const publishFn = vi.fn(async () => undefined);
    const { worker, outboxRepository } = makeWorker(publishFn);

    const draft = await worker.processBrief(makeBrief());

    expect(draft.schema_version).toBe("blog_draft.v1");

    const events = await outboxRepository.listUnconsumed(TENANT_ID, 10);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("blog_draft.v1");

    expect(publishFn).toHaveBeenCalledOnce();
    expect(publishFn).toHaveBeenCalledWith(
      `t.${TENANT_ID}.blog_draft.v1`,
      expect.objectContaining({ schema_version: "blog_draft.v1" }),
    );
  });

  it("is idempotent: replayed brief produces no new outbox entries", async () => {
    const { worker, outboxRepository } = makeWorker();
    const brief = makeBrief();

    const d1 = await worker.processBrief(brief);
    await worker.processBrief(brief);

    // Same idempotency key (brief_id + iteration 1) → only one outbox entry
    const events = await outboxRepository.listUnconsumed(TENANT_ID, 10);
    expect(events).toHaveLength(1);
    expect(d1.brief_id).toBe(BRIEF_ID);
  });

  it("rejects invalid input with a parse error", async () => {
    const { worker } = makeWorker();
    await expect(worker.processBrief({ not: "a_brief" })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// generateLlmBlogDraft — LLM path
// ---------------------------------------------------------------------------

const LLM_BLOG_BODY = `# Why PLG Beats Traditional SaaS Sales in 2026

> Why PLG matters for B2B founders right now.

## Introduction

Product-led growth is reshaping B2B SaaS.

## Core Framework

PLG flips the funnel.

## Evidence

Studies show PLG companies grow 2x faster. This is a proof point.

## Implementation

Start with a free tier and measure time-to-value.

## Conclusion

Book a strategy session to explore PLG for your business.
`;

describe("generateLlmBlogDraft", () => {
  it("returns a BlogDraftV1 using LLM prose as body when runner succeeds", async () => {
    const runner = new StubLlmCallRunner({
      "blog-draft.generate": LLM_BLOG_BODY,
    });

    const result = await generateLlmBlogDraft(makeBrief(), runner);

    expect(result).not.toBeNull();
    expect(result?.schema_version).toBe("blog_draft.v1");
    expect(result?.body_markdown).toContain("Product-led growth");
    expect(result?.quality_indicators.heading_count).toBeGreaterThan(0);
  });

  it("computes word count and reading time from LLM prose", async () => {
    const runner = new StubLlmCallRunner({
      "blog-draft.generate": LLM_BLOG_BODY,
    });

    const result = await generateLlmBlogDraft(makeBrief(), runner);

    expect(result?.word_count).toBeGreaterThan(0);
    expect(result?.reading_time_minutes).toBeGreaterThanOrEqual(1);
  });

  it("returns null when runner throws", async () => {
    const runner = {
      run: async () => {
        throw new Error("LLM down");
      },
    };
    const result = await generateLlmBlogDraft(makeBrief(), runner);
    expect(result).toBeNull();
  });

  it("returns null when runner returns empty content", async () => {
    const runner = new StubLlmCallRunner({ "blog-draft.generate": "" });
    const result = await generateLlmBlogDraft(makeBrief(), runner);
    expect(result).toBeNull();
  });
});

describe("BlogDraftWorker (LLM path)", () => {
  it("uses LLM body when runner is configured and returns content", async () => {
    const runner = new StubLlmCallRunner({
      "blog-draft.generate": LLM_BLOG_BODY,
    });
    const worker = new BlogDraftWorker({
      outboxRepository: new InMemoryOutboxRepository(),
      eventPublisher: { publish: vi.fn(async () => undefined) },
      llmCallRunner: runner,
    });

    const draft = await worker.processBrief(makeBrief());

    expect(draft.body_markdown).toContain("Product-led growth");
    expect(runner.callsFor("blog-draft.generate")).toHaveLength(1);
  });

  it("falls back to deterministic draft when LLM runner throws", async () => {
    const runner = {
      run: async () => {
        throw new Error("LLM down");
      },
    };
    const worker = new BlogDraftWorker({
      outboxRepository: new InMemoryOutboxRepository(),
      eventPublisher: { publish: vi.fn(async () => undefined) },
      llmCallRunner: runner,
    });

    const draft = await worker.processBrief(makeBrief());

    // Deterministic body contains placeholder text.
    expect(draft.body_markdown).toContain("placeholder");
  });
});
