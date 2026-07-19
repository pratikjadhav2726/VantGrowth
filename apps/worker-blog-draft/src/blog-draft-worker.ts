/**
 * BlogDraftWorker — Phase 1 / S5
 *
 * Consumes ContentBriefV1 payloads (published by ContentStrategistWorker on
 * `t.{tenantId}.content_brief.v1`) and produces a BlogDraftV1 artefact.
 *
 * Phase 1 design: all generation is deterministic (no LLM).  Each section of
 * the content brief's outline is expanded into a structured markdown block.
 * Replace `generateBlogDraft()` with an LLM-backed variant in Phase 1 S7
 * without changing the outbox contract or NATS subjects.
 *
 * Idempotency: the outbox command is keyed by `blog-draft:{brief_id}:{iteration}`
 * so a re-delivered `content_brief.v1` message generates the same key and the
 * outbox UNIQUE constraint silently discards the duplicate.
 *
 * Quality indicators are computed deterministically from the generated text:
 *   - has_cta        — body contains a CTA phrase
 *   - has_internal_links — `internal_links_suggested` from brief is > 0
 *   - heading_count  — number of markdown headings in body
 *   - flesch_score   — null in Phase 1 (LLM path will populate)
 *   - grade_level    — null in Phase 1
 */

import {
  type BlogDraftV1,
  type ContentBriefV1,
  blogDraftV1Schema,
  contentBriefV1Schema,
} from "@growthos/core";
import type { OutboxRepository } from "@growthos/db";
import {
  BLOG_DRAFT_GENERATE_PROMPT,
  type LlmCallRunner,
} from "@growthos/llm-harness";

// ---------------------------------------------------------------------------
// Markdown generation helpers
// ---------------------------------------------------------------------------

const CTA_PATTERN =
  /book\s+a|start\s+your|get\s+started|sign\s+up|learn\s+more|try\s+it|contact\s+us|schedule\s+a|request\s+a\s+demo|free\s+trial/i;

const countMarkdownHeadings = (markdown: string): number =>
  (markdown.match(/^#{1,6}\s+\S/gm) ?? []).length;

const countWords = (text: string): number =>
  text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;

/**
 * Builds a single markdown section from a brief outline entry.
 * Each key_point becomes a paragraph sentence.
 */
const renderSection = (
  title: string,
  keyPoints: string[],
  wordTarget = 200,
): string => {
  const lines: string[] = [`## ${title}`, ""];

  for (const point of keyPoints) {
    // Expand each bullet into a short paragraph (~40 words) to hit word targets.
    const sentence = point.endsWith(".") ? point : `${point}.`;
    const padding =
      " This is a placeholder that will be replaced with generated content when the LLM integration is active.";
    lines.push(sentence + padding);
    lines.push("");
  }

  // Append a structural note if there's a word target.
  if (wordTarget > 0) {
    lines.push(
      `<!-- target: ${wordTarget} words — expand this section in the LLM pass -->`,
    );
    lines.push("");
  }

  return lines.join("\n");
};

/**
 * Generates a deterministic BlogDraftV1 from a ContentBriefV1.
 *
 * Output is structurally valid and schema-conforming.  All prose is placeholder
 * text — replace with LLM output in Phase 1 S7.
 */
export const generateBlogDraft = (brief: ContentBriefV1): BlogDraftV1 => {
  const sections = brief.outline.map((section) =>
    renderSection(
      section.section_title,
      section.key_points,
      section.word_count_target,
    ),
  );

  const metaSection = `# ${brief.title}\n\n> ${brief.hook}\n\n`;
  const bodyMarkdown = `${metaSection + sections.join("\n")}\n---\n\n${brief.cta}\n`;

  const wordCount = countWords(bodyMarkdown);
  const readingTimeMinutes = Math.max(1, Math.ceil(wordCount / 200));
  const headingCount = countMarkdownHeadings(bodyMarkdown);
  const hasCta = CTA_PATTERN.test(brief.cta) || CTA_PATTERN.test(bodyMarkdown);
  const hasInternalLinks = brief.internal_links_suggested.length > 0;

  const draft: BlogDraftV1 = {
    schema_version: "blog_draft.v1",
    tenant_id: brief.tenant_id,
    ...(brief.experiment_id ? { experiment_id: brief.experiment_id } : {}),
    draft_id: crypto.randomUUID(),
    brief_id: brief.brief_id,
    generated_at: new Date().toISOString(),
    iteration: 1,
    title: brief.title,
    meta_description:
      brief.hook.slice(0, 157).trimEnd() +
      (brief.hook.length > 157 ? "..." : ""),
    body_markdown: bodyMarkdown,
    word_count: wordCount,
    reading_time_minutes: readingTimeMinutes,
    estimated_claims: [],
    quality_indicators: {
      flesch_score: null,
      grade_level: null,
      has_cta: hasCta,
      has_internal_links: hasInternalLinks,
      heading_count: headingCount,
    },
    status: "draft",
  };

  return blogDraftV1Schema.parse(draft);
};

// ---------------------------------------------------------------------------
// Outbox command builder
// ---------------------------------------------------------------------------

export const createBlogDraftOutboxCommand = (
  draft: BlogDraftV1,
  iteration = 1,
) => ({
  tenantId: draft.tenant_id,
  eventType: "blog_draft.v1",
  idempotencyKey: `blog-draft:${draft.brief_id}:${iteration}`,
  payload: draft as unknown as Record<string, unknown>,
});

// ---------------------------------------------------------------------------
// Event publisher interface
// ---------------------------------------------------------------------------

export interface EventPublisher {
  publish(subject: string, payload: Record<string, unknown>): Promise<void>;
}

// ---------------------------------------------------------------------------
// LLM blog draft generator
// ---------------------------------------------------------------------------

/**
 * Generates the `body_markdown` for a blog post via the LLM runner.
 *
 * `BLOG_DRAFT_GENERATE_PROMPT` returns raw prose markdown — the caller
 * wraps it in a `BlogDraftV1` with computed quality indicators.
 *
 * Returns `null` on any failure (runner error, empty response).
 * The caller falls back to `generateBlogDraft()`.
 */
export const generateLlmBlogDraft = async (
  brief: ContentBriefV1,
  runner: LlmCallRunner,
): Promise<BlogDraftV1 | null> => {
  let bodyMarkdown: string;
  try {
    const result = await runner.run(
      BLOG_DRAFT_GENERATE_PROMPT,
      {
        title: brief.title,
        hook: brief.hook,
        outline: brief.outline
          .map(
            (s) =>
              `${s.section_title}: ${s.key_points.join("; ")} (${s.word_count_target} words)`,
          )
          .join(" | "),
        toneNotes: brief.tone_notes,
        primaryKeyword: brief.primary_keyword,
      },
      { tenantId: brief.tenant_id },
    );
    bodyMarkdown = result.content.trim();
  } catch {
    return null;
  }

  if (!bodyMarkdown) return null;

  const wordCount = countWords(bodyMarkdown);
  const readingTimeMinutes = Math.max(1, Math.ceil(wordCount / 200));
  const headingCount = countMarkdownHeadings(bodyMarkdown);
  const hasCta = CTA_PATTERN.test(brief.cta) || CTA_PATTERN.test(bodyMarkdown);
  const hasInternalLinks = brief.internal_links_suggested.length > 0;

  const draft: BlogDraftV1 = {
    schema_version: "blog_draft.v1",
    tenant_id: brief.tenant_id,
    ...(brief.experiment_id ? { experiment_id: brief.experiment_id } : {}),
    draft_id: crypto.randomUUID(),
    brief_id: brief.brief_id,
    generated_at: new Date().toISOString(),
    iteration: 1,
    title: brief.title,
    meta_description:
      brief.hook.slice(0, 157).trimEnd() +
      (brief.hook.length > 157 ? "..." : ""),
    body_markdown: bodyMarkdown,
    word_count: wordCount,
    reading_time_minutes: readingTimeMinutes,
    estimated_claims: [],
    quality_indicators: {
      flesch_score: null,
      grade_level: null,
      has_cta: hasCta,
      has_internal_links: hasInternalLinks,
      heading_count: headingCount,
    },
    status: "draft",
  };

  return blogDraftV1Schema.parse(draft);
};

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export interface BlogDraftWorkerDependencies {
  outboxRepository: OutboxRepository;
  /** Delivery is outbox-only; retained as an optional compatibility seam. */
  eventPublisher?: EventPublisher;
  /**
   * Optional LLM runner.  When present, `processBrief()` calls
   * `generateLlmBlogDraft()` before falling back to the deterministic
   * placeholder generator.
   */
  llmCallRunner?: LlmCallRunner;
}

export class BlogDraftWorker {
  constructor(private readonly deps: BlogDraftWorkerDependencies) {}

  /**
   * Processes a `content_brief.v1` event.
   *
   * Generation order:
   *   1. If `llmCallRunner` is configured → try `generateLlmBlogDraft()`.
   *   2. On failure or no runner → `generateBlogDraft()` (deterministic).
   */
  async processBrief(input: unknown): Promise<BlogDraftV1> {
    const brief = contentBriefV1Schema.parse(input);

    const draft = this.deps.llmCallRunner
      ? ((await generateLlmBlogDraft(brief, this.deps.llmCallRunner)) ??
        generateBlogDraft(brief))
      : generateBlogDraft(brief);
    const command = createBlogDraftOutboxCommand(draft, draft.iteration);

    await this.deps.outboxRepository.enqueue(command);

    return draft;
  }
}
