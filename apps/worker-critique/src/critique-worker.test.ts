import {
  InMemoryOutboxRepository,
  InMemoryPlaybookVersionsRepository,
} from "@growthos/db";
import { StubLlmCallRunner } from "@growthos/llm-harness";
import { describe, expect, it, vi } from "vitest";
import {
  CritiqueWorker,
  type EventPublisher,
  critiqueWithLlm,
  scoreCritique,
} from "./critique-worker.js";
import {
  artifactKindToPlaybookType,
  evaluateCriterion,
  evaluateCriterionWithLlm,
  evaluateRubric,
  evaluateRubricAsync,
  isKnownCheck,
} from "./playbook-rubric.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TENANT_ID = "00000000-0000-4000-8000-000000000001";

const baseRequest = {
  tenantId: TENANT_ID,
  critiqueId: "crit-1",
  dedupeKey: "crit-1",
  source: "worker-heartbeat",
  artifactKind: "blog_draft.v1",
  artifactId: "artifact-1",
  promptVersion: "v1",
  reviewerNotes: [] as string[],
};

const richOutput =
  "This draft includes clear sections, supporting claims, concise narrative flow, " +
  "concrete customer evidence, and explicit CTA language tuned to the target channel " +
  "so it can pass a quality gate without requiring immediate revision.";

const makeRubric = (overrides: Record<string, unknown> = {}) => ({
  rubric: [
    {
      id: "r1",
      weight: 0.4,
      description: "Has a call to action",
      check: "has_cta",
    },
    {
      id: "r2",
      weight: 0.35,
      description: "Contains evidence",
      check: "has_evidence",
    },
    {
      id: "r3",
      weight: 0.25,
      description: "No forbidden phrases",
      check: "no_forbidden",
    },
  ],
  min_word_count: 20,
  max_word_count: 2000,
  forbidden_phrases: ["market leader", "industry-leading"],
  ...overrides,
});

const makeWorker = (
  publishFn = vi.fn(async () => undefined),
  playbookRepository?: InMemoryPlaybookVersionsRepository,
) => {
  const outboxRepository = new InMemoryOutboxRepository();
  const eventPublisher: EventPublisher = { publish: publishFn };
  const worker = new CritiqueWorker({
    outboxRepository,
    eventPublisher,
    ...(playbookRepository ? { playbookRepository } : {}),
  });
  return { worker, outboxRepository, eventPublisher };
};

// ---------------------------------------------------------------------------
// scoreCritique — heuristic fallback
// ---------------------------------------------------------------------------

describe("scoreCritique (heuristic)", () => {
  it("returns revise when reviewer notes are present", () => {
    const result = scoreCritique({
      tenantId: TENANT_ID,
      candidateOutput: "Concise copy that still needs citations.",
      reviewerNotes: ["missing source links"],
      artifactKind: "blog_draft.v1",
    });
    expect(result.verdict).toBe("revise");
    expect(result.confidenceScore).toBeLessThan(0.7);
  });

  it("returns revise for short output even without reviewer notes", () => {
    const result = scoreCritique({
      tenantId: TENANT_ID,
      candidateOutput: "Too short.",
      reviewerNotes: [],
      artifactKind: "blog_draft.v1",
    });
    expect(result.verdict).toBe("revise");
  });

  it("returns reject for very long output", () => {
    const result = scoreCritique({
      tenantId: TENANT_ID,
      candidateOutput: "x".repeat(1250),
      reviewerNotes: [],
      artifactKind: "blog_draft.v1",
    });
    expect(result.verdict).toBe("reject");
  });

  it("returns approve for well-formed output within length bounds", () => {
    const result = scoreCritique({
      tenantId: TENANT_ID,
      candidateOutput: richOutput,
      reviewerNotes: [],
      artifactKind: "blog_draft.v1",
    });
    expect(result.verdict).toBe("approve");
  });
});

// ---------------------------------------------------------------------------
// evaluateCriterion
// ---------------------------------------------------------------------------

describe("evaluateCriterion", () => {
  it("has_cta: passes when text contains a CTA phrase", () => {
    const result = evaluateCriterion(
      "has_cta",
      "Get started today for free.",
      {},
    );
    expect(result.passed).toBe(true);
  });

  it("has_cta: fails when no CTA phrase present", () => {
    const result = evaluateCriterion(
      "has_cta",
      "Here is some info about our product.",
      {},
    );
    expect(result.passed).toBe(false);
  });

  it("has_evidence: passes when text contains a percentage", () => {
    const result = evaluateCriterion(
      "has_evidence",
      "Companies see a 43% increase.",
      {},
    );
    expect(result.passed).toBe(true);
  });

  it("has_evidence: passes when text references a study", () => {
    const result = evaluateCriterion(
      "has_evidence",
      "According to a recent study, PLG wins.",
      {},
    );
    expect(result.passed).toBe(true);
  });

  it("has_evidence: fails with no quantitative evidence", () => {
    const result = evaluateCriterion(
      "has_evidence",
      "This is good content.",
      {},
    );
    expect(result.passed).toBe(false);
  });

  it("no_forbidden: passes when no forbidden phrases present", () => {
    const result = evaluateCriterion("no_forbidden", "Our product is solid.", {
      forbiddenPhrases: ["market leader", "industry-leading"],
    });
    expect(result.passed).toBe(true);
  });

  it("no_forbidden: fails when a forbidden phrase is present", () => {
    const result = evaluateCriterion(
      "no_forbidden",
      "We are the market leader.",
      {
        forbiddenPhrases: ["market leader"],
      },
    );
    expect(result.passed).toBe(false);
    expect(result.details).toContain("market leader");
  });

  it("length_ok: passes when word count is within range", () => {
    const result = evaluateCriterion("length_ok", "word ".repeat(50), {
      minWordCount: 30,
      maxWordCount: 100,
    });
    expect(result.passed).toBe(true);
  });

  it("length_ok: fails when below min_word_count", () => {
    const result = evaluateCriterion("length_ok", "Too short.", {
      minWordCount: 100,
    });
    expect(result.passed).toBe(false);
  });

  it("has_headings: passes when markdown headings present", () => {
    const result = evaluateCriterion(
      "has_headings",
      "## Introduction\nSome content.",
      {},
    );
    expect(result.passed).toBe(true);
  });

  it("unknown check auto-passes", () => {
    const result = evaluateCriterion("future_llm_check", "Any text.", {});
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// evaluateRubric
// ---------------------------------------------------------------------------

describe("evaluateRubric", () => {
  it("returns score 1.0 when all criteria pass", () => {
    const text =
      "## Why PLG Wins\n" +
      "According to a recent study, 67% of B2B buyers prefer self-service. " +
      "Get started with our free trial today.";
    const result = evaluateRubric(makeRubric(), text);
    expect(result.score).toBe(1);
    expect(result.criteriaResults.every((c) => c.passed)).toBe(true);
  });

  it("returns score 0 when all criteria fail", () => {
    const text = "We are the industry-leading market leader.";
    const result = evaluateRubric(makeRubric(), text);
    expect(result.score).toBeLessThan(0.3);
  });

  it("normalises weights to sum to 1 even with misconfigured rubric", () => {
    const rubric = makeRubric({
      rubric: [
        { id: "r1", weight: 100, description: "CTA", check: "has_cta" },
        {
          id: "r2",
          weight: 100,
          description: "Evidence",
          check: "has_evidence",
        },
      ],
    });
    const result = evaluateRubric(rubric, "Get started — study shows 43% ROI.");
    expect(result.score).toBeCloseTo(1, 1);
  });
});

// ---------------------------------------------------------------------------
// CritiqueWorker integration
// ---------------------------------------------------------------------------

describe("CritiqueWorker — heuristic path (no playbookRepository)", () => {
  it("emits critique.completed.v1 to the durable outbox", async () => {
    const publishFn = vi.fn(async () => undefined);
    const { worker, outboxRepository } = makeWorker(publishFn);

    const result = await worker.critique({
      ...baseRequest,
      candidateOutput: richOutput,
    });

    expect(result.verdict).toBe("approve");
    expect(publishFn).not.toHaveBeenCalled();
    const events = await outboxRepository.listUnconsumed(TENANT_ID, 10);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("critique.completed.v1");
  });

  it("is idempotent for duplicate critiques", async () => {
    const { worker, outboxRepository } = makeWorker();
    const req = {
      ...baseRequest,
      candidateOutput: "Short text.",
      dedupeKey: "d1",
      reviewerNotes: ["note"],
    };
    await worker.critique(req);
    await worker.critique(req);
    const events = await outboxRepository.listUnconsumed(TENANT_ID, 10);
    expect(events).toHaveLength(1);
  });
});

describe("CritiqueWorker — playbook path", () => {
  const seedPlaybook = async (
    repo: InMemoryPlaybookVersionsRepository,
    content: Record<string, unknown>,
    playbookType: "blog_draft" | "content_brief" = "blog_draft",
  ) =>
    repo.create(TENANT_ID, {
      playbookType,
      name: "Test Playbook",
      content,
      createdBy: "test",
    });

  it("uses rubric scoring when active playbook exists for artifact kind", async () => {
    const playbookRepository = new InMemoryPlaybookVersionsRepository();
    await seedPlaybook(playbookRepository, makeRubric());
    const { worker } = makeWorker(
      vi.fn(async () => undefined),
      playbookRepository,
    );

    // Text that passes all rubric criteria
    const goodText =
      "## Why PLG Works\n" +
      "According to a study, 67% of buyers prefer self-service. " +
      "Start your free trial today.";
    const result = await worker.critique({
      ...baseRequest,
      candidateOutput: goodText,
    });
    expect(result.verdict).toBe("approve");
    expect(result.confidenceScore).toBeCloseTo(1, 1);
  });

  it("returns revise when rubric score is between 0.5 and 0.8", async () => {
    const playbookRepository = new InMemoryPlaybookVersionsRepository();
    // Rubric: 2 criteria, candidate only passes 1
    await seedPlaybook(playbookRepository, {
      rubric: [
        { id: "r1", weight: 0.5, description: "Has CTA", check: "has_cta" },
        {
          id: "r2",
          weight: 0.5,
          description: "Has evidence",
          check: "has_evidence",
        },
      ],
    });
    const { worker } = makeWorker(
      vi.fn(async () => undefined),
      playbookRepository,
    );

    // Only has CTA (passes r1), no evidence (fails r2) → score 0.5 → revise
    const result = await worker.critique({
      ...baseRequest,
      candidateOutput: "Get started today. ".repeat(10),
    });
    expect(result.verdict).toBe("revise");
  });

  it("returns reject when rubric score is below 0.5", async () => {
    const playbookRepository = new InMemoryPlaybookVersionsRepository();
    await seedPlaybook(playbookRepository, {
      rubric: [
        { id: "r1", weight: 0.4, description: "Has CTA", check: "has_cta" },
        {
          id: "r2",
          weight: 0.35,
          description: "Has evidence",
          check: "has_evidence",
        },
        {
          id: "r3",
          weight: 0.25,
          description: "No forbidden",
          check: "no_forbidden",
        },
      ],
      forbidden_phrases: ["market leader"],
    });
    const { worker } = makeWorker(
      vi.fn(async () => undefined),
      playbookRepository,
    );

    // Text fails all criteria: no CTA, no evidence, has forbidden phrase
    const result = await worker.critique({
      ...baseRequest,
      candidateOutput: "We are the market leader in this category.",
    });
    expect(result.verdict).toBe("reject");
  });

  it("falls back to heuristic when no active playbook exists for tenant", async () => {
    const playbookRepository = new InMemoryPlaybookVersionsRepository();
    // No playbook seeded for TENANT_ID
    const { worker } = makeWorker(
      vi.fn(async () => undefined),
      playbookRepository,
    );

    const result = await worker.critique({
      ...baseRequest,
      candidateOutput: richOutput,
    });
    // Heuristic approve path
    expect(result.verdict).toBe("approve");
    expect(result.confidenceScore).toBeGreaterThan(0.8);
  });

  it("falls back to heuristic when playbook content is not a valid rubric", async () => {
    const playbookRepository = new InMemoryPlaybookVersionsRepository();
    await seedPlaybook(playbookRepository, { not_a_rubric: true });
    const { worker } = makeWorker(
      vi.fn(async () => undefined),
      playbookRepository,
    );

    // Should not throw; uses heuristic
    const result = await worker.critique({
      ...baseRequest,
      candidateOutput: richOutput,
    });
    expect(result.verdict).toBe("approve");
  });

  it("uses content_brief playbook for content_brief.v1 artifacts", async () => {
    const playbookRepository = new InMemoryPlaybookVersionsRepository();
    await seedPlaybook(
      playbookRepository,
      {
        rubric: [
          { id: "r1", weight: 1, description: "Has CTA", check: "has_cta" },
        ],
      },
      "content_brief",
    );
    const { worker } = makeWorker(
      vi.fn(async () => undefined),
      playbookRepository,
    );

    const result = await worker.critique({
      ...baseRequest,
      artifactKind: "content_brief.v1",
      candidateOutput: "Sign up for our beta program today.",
    });
    expect(result.verdict).toBe("approve");
    expect(result.confidenceScore).toBeCloseTo(1, 1);
  });

  it("reasons list is non-empty on failure", async () => {
    const playbookRepository = new InMemoryPlaybookVersionsRepository();
    await seedPlaybook(playbookRepository, makeRubric());
    const { worker } = makeWorker(
      vi.fn(async () => undefined),
      playbookRepository,
    );

    const result = await worker.critique({
      ...baseRequest,
      candidateOutput: "Short plain text without calls to action.",
    });
    expect(result.reasons.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// critiqueWithLlm
// ---------------------------------------------------------------------------

const CRITIQUE_TEMPLATE_ID = "critique.evaluate";

const VALID_LLM_VERDICT_JSON = JSON.stringify({
  verdict: "approve",
  confidence_score: 0.9,
  reasons: ["Structure is clear", "Strong CTA present"],
});

describe("critiqueWithLlm", () => {
  it("returns verdict and reasons for a valid JSON LLM response", async () => {
    const runner = new StubLlmCallRunner({
      [CRITIQUE_TEMPLATE_ID]: VALID_LLM_VERDICT_JSON,
    });
    const result = await critiqueWithLlm(
      {
        tenantId: TENANT_ID,
        artifactKind: "blog_draft.v1",
        candidateOutput: richOutput,
        reviewerNotes: [],
      },
      runner,
    );
    expect(result).not.toBeNull();
    expect(result?.verdict).toBe("approve");
    expect(result?.confidenceScore).toBe(0.9);
    expect(result?.reasons).toHaveLength(2);
  });

  it("normalises camelCase confidenceScore key", async () => {
    const runner = new StubLlmCallRunner({
      [CRITIQUE_TEMPLATE_ID]: JSON.stringify({
        verdict: "revise",
        confidenceScore: 0.65,
        reasons: ["Needs more evidence"],
      }),
    });
    const result = await critiqueWithLlm(
      {
        tenantId: TENANT_ID,
        artifactKind: "blog_draft.v1",
        candidateOutput: richOutput,
        reviewerNotes: [],
      },
      runner,
    );
    expect(result?.confidenceScore).toBe(0.65);
  });

  it("defaults confidenceScore to 0.7 when not present in response", async () => {
    const runner = new StubLlmCallRunner({
      [CRITIQUE_TEMPLATE_ID]: JSON.stringify({
        verdict: "revise",
        reasons: ["Too short"],
      }),
    });
    const result = await critiqueWithLlm(
      {
        tenantId: TENANT_ID,
        artifactKind: "blog_draft.v1",
        candidateOutput: richOutput,
        reviewerNotes: [],
      },
      runner,
    );
    expect(result?.confidenceScore).toBe(0.7);
  });

  it("returns null when LLM response contains no JSON", async () => {
    const runner = new StubLlmCallRunner({
      [CRITIQUE_TEMPLATE_ID]: "Sorry, I cannot evaluate this.",
    });
    const result = await critiqueWithLlm(
      {
        tenantId: TENANT_ID,
        artifactKind: "blog_draft.v1",
        candidateOutput: richOutput,
        reviewerNotes: [],
      },
      runner,
    );
    expect(result).toBeNull();
  });

  it("returns null when JSON fails schema validation (unknown verdict)", async () => {
    const runner = new StubLlmCallRunner({
      [CRITIQUE_TEMPLATE_ID]: JSON.stringify({
        verdict: "unclear",
        reasons: ["Hmm"],
      }),
    });
    const result = await critiqueWithLlm(
      {
        tenantId: TENANT_ID,
        artifactKind: "blog_draft.v1",
        candidateOutput: richOutput,
        reviewerNotes: [],
      },
      runner,
    );
    expect(result).toBeNull();
  });

  it("returns null when the runner throws", async () => {
    // Simulate runner failure by replacing the run method.
    const runner = new StubLlmCallRunner({});
    vi.spyOn(runner, "run").mockRejectedValueOnce(new Error("LLM unavailable"));
    const result = await critiqueWithLlm(
      {
        tenantId: TENANT_ID,
        artifactKind: "blog_draft.v1",
        candidateOutput: richOutput,
        reviewerNotes: [],
      },
      runner,
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CritiqueWorker — LLM path
// ---------------------------------------------------------------------------

describe("CritiqueWorker — LLM path", () => {
  const makePublisher = () => {
    const events: Array<[string, Record<string, unknown>]> = [];
    const publisher: EventPublisher = {
      publish: async (s, p) => {
        events.push([s, p]);
      },
    };
    return { publisher, events };
  };

  it("uses LLM verdict when runner is injected and returns valid JSON", async () => {
    const runner = new StubLlmCallRunner({
      [CRITIQUE_TEMPLATE_ID]: VALID_LLM_VERDICT_JSON,
    });
    const outbox = new InMemoryOutboxRepository();
    const { publisher } = makePublisher();

    const worker = new CritiqueWorker({
      outboxRepository: outbox,
      eventPublisher: publisher,
      llmCallRunner: runner,
    });

    const result = await worker.critique({
      ...baseRequest,
      candidateOutput: richOutput,
    });

    expect(result.verdict).toBe("approve");
    expect(result.confidenceScore).toBe(0.9);
    expect(runner.callHistory).toHaveLength(1);
    expect(runner.callHistory[0]?.templateId).toBe(CRITIQUE_TEMPLATE_ID);
  });

  it("falls back to heuristic when LLM returns no JSON", async () => {
    const runner = new StubLlmCallRunner({
      [CRITIQUE_TEMPLATE_ID]: "I cannot evaluate this right now.",
    });
    const outbox = new InMemoryOutboxRepository();
    const { publisher } = makePublisher();

    const worker = new CritiqueWorker({
      outboxRepository: outbox,
      eventPublisher: publisher,
      llmCallRunner: runner,
    });

    const result = await worker.critique({
      ...baseRequest,
      candidateOutput: richOutput,
    });

    // Heuristic on richOutput → approve
    expect(result.verdict).toBe("approve");
    expect(result.confidenceScore).toBe(0.86);
  });

  it("falls back to playbook rubric when LLM runner throws", async () => {
    const runner = new StubLlmCallRunner({});
    vi.spyOn(runner, "run").mockRejectedValueOnce(new Error("LLM unavailable"));

    const outbox = new InMemoryOutboxRepository();
    const { publisher } = makePublisher();

    const playbookRepository = new InMemoryPlaybookVersionsRepository();
    await playbookRepository.create(TENANT_ID, {
      playbookType: "blog_draft",
      name: "LLM fallback test playbook",
      content: makeRubric({
        rubric: [
          {
            id: "has_cta",
            description: "Contains a call to action",
            check: "has_cta",
            weight: 1,
          },
        ],
      }),
      createdBy: "test",
    });

    const worker = new CritiqueWorker({
      outboxRepository: outbox,
      eventPublisher: publisher,
      llmCallRunner: runner,
      playbookRepository,
    });

    const result = await worker.critique({
      ...baseRequest,
      candidateOutput:
        "Get started with a free trial today and transform your GTM.",
    });

    // Playbook rubric path: has_cta passes (matches "get started" and "free trial") → approve
    expect(result.verdict).toBe("approve");
  });

  it("emits critique.completed.v1 event with LLM-derived verdict", async () => {
    const runner = new StubLlmCallRunner({
      [CRITIQUE_TEMPLATE_ID]: VALID_LLM_VERDICT_JSON,
    });
    const outbox = new InMemoryOutboxRepository();
    const { publisher, events: publishedEvents } = makePublisher();

    const worker = new CritiqueWorker({
      outboxRepository: outbox,
      eventPublisher: publisher,
      llmCallRunner: runner,
    });

    await worker.critique({ ...baseRequest, candidateOutput: richOutput });

    const events = await outbox.listUnconsumed(TENANT_ID, 10);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.verdict).toBe("approve");
    expect(events[0]?.payload.confidence_score).toBe(0.9);
    expect(publishedEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// isKnownCheck
// ---------------------------------------------------------------------------

describe("isKnownCheck", () => {
  it("returns true for all six deterministic check types", () => {
    for (const check of [
      "has_cta",
      "has_evidence",
      "no_forbidden",
      "length_ok",
      "has_headings",
      "has_hook",
    ]) {
      expect(isKnownCheck(check)).toBe(true);
    }
  });

  it("returns false for custom/unknown check types", () => {
    expect(isKnownCheck("brand_voice")).toBe(false);
    expect(isKnownCheck("technical_depth")).toBe(false);
    expect(isKnownCheck("future_llm_check")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateCriterionWithLlm
// ---------------------------------------------------------------------------

const CRITERION_TEMPLATE_ID = "rubric.criterion.evaluate";

const makeCustomCriterion = () => ({
  id: "brand-voice",
  weight: 0.5,
  description: "Text adopts a confident, founder-voice tone",
  check: "brand_voice",
});

describe("evaluateCriterionWithLlm", () => {
  it("returns passed=true and LLM explanation for a passing response", async () => {
    const runner = new StubLlmCallRunner({
      [CRITERION_TEMPLATE_ID]: JSON.stringify({
        passed: true,
        confidence: 0.88,
        explanation: "Tone is direct and confident.",
      }),
    });

    const result = await evaluateCriterionWithLlm(
      makeCustomCriterion(),
      "We built this to solve a real problem we lived.",
      runner,
    );

    expect(result.passed).toBe(true);
    expect(result.details).toBe("Tone is direct and confident.");
  });

  it("returns passed=false when LLM judges criterion not met", async () => {
    const runner = new StubLlmCallRunner({
      [CRITERION_TEMPLATE_ID]: JSON.stringify({
        passed: false,
        confidence: 0.75,
        explanation: "Text reads as corporate boilerplate.",
      }),
    });

    const result = await evaluateCriterionWithLlm(
      makeCustomCriterion(),
      "Our industry-leading solution drives synergy.",
      runner,
    );

    expect(result.passed).toBe(false);
    expect(result.details).toContain("corporate boilerplate");
  });

  it("auto-passes when LLM response contains no JSON", async () => {
    const runner = new StubLlmCallRunner({
      [CRITERION_TEMPLATE_ID]: "I cannot evaluate this criterion.",
    });

    const result = await evaluateCriterionWithLlm(
      makeCustomCriterion(),
      "Some text.",
      runner,
    );

    expect(result.passed).toBe(true);
    expect(result.details).toContain("auto-passed");
  });

  it("auto-passes when the runner throws", async () => {
    const runner = new StubLlmCallRunner({});
    vi.spyOn(runner, "run").mockRejectedValueOnce(new Error("LLM unavailable"));

    const result = await evaluateCriterionWithLlm(
      makeCustomCriterion(),
      "Some text.",
      runner,
    );

    expect(result.passed).toBe(true);
    expect(result.details).toContain("auto-passed");
  });
});

// ---------------------------------------------------------------------------
// evaluateRubricAsync
// ---------------------------------------------------------------------------

describe("evaluateRubricAsync", () => {
  it("evaluates known checks without calling the LLM", async () => {
    const runner = new StubLlmCallRunner({
      [CRITERION_TEMPLATE_ID]: JSON.stringify({ passed: true }),
    });
    const rubric = makeRubric(); // all known checks

    await evaluateRubricAsync(rubric, richOutput, runner);

    // No LLM calls should have been made — all checks are deterministic.
    expect(runner.callHistory).toHaveLength(0);
  });

  it("calls LLM for custom checks when runner is provided", async () => {
    const runner = new StubLlmCallRunner({
      [CRITERION_TEMPLATE_ID]: JSON.stringify({
        passed: true,
        explanation: "Brand voice detected.",
      }),
    });
    const rubric = {
      rubric: [
        {
          id: "brand-voice",
          weight: 1,
          description: "Founder voice tone",
          check: "brand_voice", // unknown check
        },
      ],
    };

    const result = await evaluateRubricAsync(rubric, richOutput, runner);

    expect(runner.callHistory).toHaveLength(1);
    expect(runner.callHistory[0]?.templateId).toBe(CRITERION_TEMPLATE_ID);
    expect(result.score).toBe(1);
    expect(result.criteriaResults[0]?.passed).toBe(true);
  });

  it("auto-passes custom checks when no LLM runner is provided", async () => {
    const rubric = {
      rubric: [
        {
          id: "technical-depth",
          weight: 1,
          description: "Appropriate technical depth for ICP",
          check: "technical_depth",
        },
      ],
    };

    const result = await evaluateRubricAsync(
      rubric,
      "Some content.",
      undefined,
    );

    expect(result.score).toBe(1);
    expect(result.criteriaResults[0]?.details).toContain("auto-passed");
  });
});

// ---------------------------------------------------------------------------
// CritiqueWorker — custom rubric criterion via LLM
// ---------------------------------------------------------------------------

describe("CritiqueWorker — custom rubric criterion via LLM", () => {
  it("delegates custom rubric check to LLM runner inside scoreWithPlaybook", async () => {
    const runner = new StubLlmCallRunner({
      // High-confidence approve from the top-level LLM critique path
      [CRITIQUE_TEMPLATE_ID]: VALID_LLM_VERDICT_JSON,
      // Criterion-level LLM response for the custom check
      [CRITERION_TEMPLATE_ID]: JSON.stringify({
        passed: false,
        explanation: "Text lacks founder voice.",
      }),
    });

    // Wire the runner to return no JSON for the top-level critique so it falls
    // through to the playbook path, which then calls the criterion LLM.
    const noOpRunner = new StubLlmCallRunner({
      [CRITIQUE_TEMPLATE_ID]: "Cannot evaluate.",
      [CRITERION_TEMPLATE_ID]: JSON.stringify({
        passed: false,
        explanation: "Missing founder perspective.",
      }),
    });

    const playbookRepository = new InMemoryPlaybookVersionsRepository();
    await playbookRepository.create(TENANT_ID, {
      playbookType: "blog_draft",
      name: "Brand voice playbook",
      content: {
        rubric: [
          {
            id: "brand-voice",
            weight: 1,
            description: "Founder-voice tone throughout",
            check: "brand_voice",
          },
        ],
      },
      createdBy: "test",
    });

    const outbox = new InMemoryOutboxRepository();
    const worker = new CritiqueWorker({
      outboxRepository: outbox,
      eventPublisher: { publish: vi.fn(async () => undefined) },
      llmCallRunner: noOpRunner,
      playbookRepository,
    });

    const result = await worker.critique({
      ...baseRequest,
      candidateOutput:
        "Our synergistic platform leverages best-in-class paradigms.",
    });

    // Playbook: brand_voice fails (LLM says so) → score 0 → reject
    expect(result.verdict).toBe("reject");
    // Criterion LLM was called
    expect(
      noOpRunner.callHistory.some(
        (c) => c.templateId === CRITERION_TEMPLATE_ID,
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// artifactKindToPlaybookType
// ---------------------------------------------------------------------------

describe("artifactKindToPlaybookType", () => {
  it("maps blog_draft.v1 → blog_draft", () =>
    expect(artifactKindToPlaybookType("blog_draft.v1")).toBe("blog_draft"));
  it("maps content_brief.v1 → content_brief", () =>
    expect(artifactKindToPlaybookType("content_brief.v1")).toBe(
      "content_brief",
    ));
  it("maps intel_brief.v1 → intel_brief", () =>
    expect(artifactKindToPlaybookType("intel_brief.v1")).toBe("intel_brief"));
  it("returns null for unknown kinds", () =>
    expect(artifactKindToPlaybookType("unknown_kind.v1")).toBeNull());
});
