import { intelBriefV1Schema } from "@growthos/core";
import { InMemoryOutboxRepository } from "@growthos/db";
import { StubLlmCallRunner } from "@growthos/llm-harness";
import { describe, expect, it, vi } from "vitest";
import {
  type EventPublisher,
  IntelDirectorWorker,
  generateDeterministicBrief,
  generateLlmBrief,
  intelBriefRequestedV1Schema,
} from "./intel-director-worker.js";

const TENANT_ID = "00000000-0000-4000-8000-000000000002";
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

const makeValidRequest = (overrides: Record<string, unknown> = {}) => ({
  schema_version: "intel_brief_requested.v1" as const,
  request_id: REQUEST_ID,
  tenant_id: TENANT_ID,
  period_from: "2026-04-01",
  period_to: "2026-04-28",
  requested_by: "system",
  ...overrides,
});

describe("intelBriefRequestedV1Schema", () => {
  it("accepts a minimal valid request", () => {
    const parsed = intelBriefRequestedV1Schema.parse(makeValidRequest());
    expect(parsed.tenant_id).toBe(TENANT_ID);
    expect(parsed.requested_by).toBe("system");
  });

  it("rejects an invalid period_from format", () => {
    expect(() =>
      intelBriefRequestedV1Schema.parse(
        makeValidRequest({ period_from: "April 1 2026" }),
      ),
    ).toThrow();
  });

  it("accepts motion_context with primary_motions", () => {
    const parsed = intelBriefRequestedV1Schema.parse(
      makeValidRequest({
        motion_context: {
          primary_motions: ["plg", "inbound_content"],
          icp_summary: "B2B SaaS, 50-500 employees",
        },
      }),
    );
    expect(parsed.motion_context?.primary_motions).toEqual([
      "plg",
      "inbound_content",
    ]);
  });

  it("defaults requested_by to 'system'", () => {
    const parsed = intelBriefRequestedV1Schema.parse(
      makeValidRequest({ requested_by: undefined }),
    );
    expect(parsed.requested_by).toBe("system");
  });
});

describe("generateDeterministicBrief", () => {
  it("generates a schema-valid IntelBriefV1", () => {
    const request = intelBriefRequestedV1Schema.parse(makeValidRequest());
    const brief = generateDeterministicBrief(request);
    expect(() => intelBriefV1Schema.parse(brief)).not.toThrow();
  });

  it("always includes at least one content_opportunity", () => {
    const request = intelBriefRequestedV1Schema.parse(makeValidRequest());
    const brief = generateDeterministicBrief(request);
    expect(brief.content_opportunities.length).toBeGreaterThanOrEqual(1);
  });

  it("uses primary_motion from context when provided", () => {
    const request = intelBriefRequestedV1Schema.parse(
      makeValidRequest({
        motion_context: { primary_motions: ["plg"] },
      }),
    );
    const brief = generateDeterministicBrief(request);
    expect(brief.content_opportunities[0]?.motion_fit).toContain("plg");
    expect(brief.recommended_focus).toContain("plg");
  });

  it("falls back to inbound_content when no motion context", () => {
    const request = intelBriefRequestedV1Schema.parse(makeValidRequest());
    const brief = generateDeterministicBrief(request);
    expect(brief.content_opportunities[0]?.motion_fit).toContain(
      "inbound_content",
    );
  });

  it("includes icp_summary in recommended_focus when provided", () => {
    const request = intelBriefRequestedV1Schema.parse(
      makeValidRequest({
        motion_context: {
          primary_motions: ["inbound_content"],
          icp_summary: "B2B SaaS founders",
        },
      }),
    );
    const brief = generateDeterministicBrief(request);
    expect(brief.recommended_focus).toContain("B2B SaaS founders");
  });

  it("sets correct period from request", () => {
    const request = intelBriefRequestedV1Schema.parse(makeValidRequest());
    const brief = generateDeterministicBrief(request);
    expect(brief.period.from).toBe("2026-04-01");
    expect(brief.period.to).toBe("2026-04-28");
  });

  it("preserves experiment lineage from the durable request", () => {
    const experimentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const request = intelBriefRequestedV1Schema.parse(
      makeValidRequest({ experiment_id: experimentId }),
    );

    expect(generateDeterministicBrief(request).experiment_id).toBe(experimentId);
  });

  it("grounds a deterministic brief in its triggering signal", () => {
    const request = intelBriefRequestedV1Schema.parse(
      makeValidRequest({
        trigger: {
          signal_id: "42",
          signal_type: "competitive",
          source: "competitor.watch",
          kind: "competitor.pricing_change",
          priority: "P1",
          payload: {
            competitor: "Acme",
            summary: "Acme introduced a free tier for mid-market buyers.",
            source_url: "https://example.com/pricing",
          },
          occurred_at: "2026-04-14T10:00:00.000Z",
        },
      }),
    );

    const brief = generateDeterministicBrief(request);

    expect(brief.competitive_signals[0]).toMatchObject({
      competitor: "Acme",
      signal_type: "pricing_change",
      source_url: "https://example.com/pricing",
    });
    expect(brief.content_opportunities[0]?.rationale).toContain("Acme");
  });

  it("generates unique brief_ids on consecutive calls", () => {
    const request = intelBriefRequestedV1Schema.parse(makeValidRequest());
    const brief1 = generateDeterministicBrief(request);
    const brief2 = generateDeterministicBrief(request);
    expect(brief1.brief_id).not.toBe(brief2.brief_id);
  });
});

describe("IntelDirectorWorker", () => {
  const makeWorker = (publishFn = vi.fn(async () => undefined)) => {
    const outboxRepository = new InMemoryOutboxRepository();
    const eventPublisher: EventPublisher = { publish: publishFn };
    const worker = new IntelDirectorWorker({
      outboxRepository,
      eventPublisher,
    });
    return { worker, outboxRepository, eventPublisher };
  };

  it("enqueues intel_brief.v1 in the durable outbox", async () => {
    const publishFn = vi.fn(async () => undefined);
    const { worker, outboxRepository } = makeWorker(publishFn);

    const result = await worker.processBriefRequest(makeValidRequest());

    expect(result.schema_version).toBe("intel_brief.v1");
    expect(result.tenant_id).toBe(TENANT_ID);

    const events = await outboxRepository.listUnconsumed(TENANT_ID, 10);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("intel_brief.v1");

    expect(publishFn).not.toHaveBeenCalled();
  });

  it("is idempotent: duplicate request_id is dropped by outbox constraint", async () => {
    const { worker, outboxRepository } = makeWorker();

    await worker.processBriefRequest(makeValidRequest());
    await worker.processBriefRequest(makeValidRequest());

    const events = await outboxRepository.listUnconsumed(TENANT_ID, 10);
    expect(events).toHaveLength(1);
  });

  it("rejects an invalid input payload", async () => {
    const { worker } = makeWorker();
    await expect(
      worker.processBriefRequest({ not: "a_valid_request" }),
    ).rejects.toThrow();
  });

  it("includes motion context in the generated brief when provided", async () => {
    const { worker } = makeWorker();

    const result = await worker.processBriefRequest(
      makeValidRequest({
        motion_context: {
          primary_motions: ["community_engagement"],
          icp_summary: "Developer tools for indie hackers",
        },
      }),
    );

    expect(result.content_opportunities[0]?.motion_fit).toContain(
      "community_engagement",
    );
    expect(result.recommended_focus).toContain(
      "Developer tools for indie hackers",
    );
  });
});

// ---------------------------------------------------------------------------
// generateLlmBrief — LLM-backed path
// ---------------------------------------------------------------------------

const VALID_LLM_BRIEF_JSON = (tenantId: string) =>
  JSON.stringify({
    schema_version: "intel_brief.v1",
    tenant_id: tenantId,
    brief_id: "22222222-2222-4222-8222-222222222222",
    generated_at: "2026-04-28T10:00:00.000Z",
    period: { from: "2026-04-01", to: "2026-04-28" },
    competitive_signals: [],
    community_signals: [],
    content_opportunities: [
      {
        opportunity_id: "33333333-3333-4333-8333-333333333333",
        title: "LLM-generated opportunity",
        rationale: "Competitor weakness identified via signal analysis.",
        urgency: "this_week",
        motion_fit: ["inbound_content"],
        score: 0.82,
      },
    ],
    recommended_focus:
      "Publish founder-voice content addressing competitor's pricing gap.",
  });

describe("generateLlmBrief", () => {
  const baseRequest = intelBriefRequestedV1Schema.parse({
    schema_version: "intel_brief_requested.v1",
    request_id: REQUEST_ID,
    tenant_id: TENANT_ID,
    period_from: "2026-04-01",
    period_to: "2026-04-28",
  });

  it("returns a parsed IntelBriefV1 when the LLM returns valid JSON", async () => {
    const runner = new StubLlmCallRunner({
      "intel-brief.generate-structured": VALID_LLM_BRIEF_JSON(TENANT_ID),
    });
    const result = await generateLlmBrief(baseRequest, runner);

    expect(result).not.toBeNull();
    expect(result?.schema_version).toBe("intel_brief.v1");
    expect(result?.content_opportunities[0]?.title).toBe(
      "LLM-generated opportunity",
    );
    expect(result?.content_opportunities[0]?.score).toBe(0.82);
  });

  it("returns null when the LLM response contains no JSON object", async () => {
    const runner = new StubLlmCallRunner({
      "intel-brief.generate-structured": "Sorry, I cannot generate this brief.",
    });
    const result = await generateLlmBrief(baseRequest, runner);
    expect(result).toBeNull();
  });

  it("returns null when the LLM JSON fails schema validation", async () => {
    const runner = new StubLlmCallRunner({
      "intel-brief.generate-structured": JSON.stringify({
        schema_version: "wrong_version",
        tenant_id: TENANT_ID,
      }),
    });
    const result = await generateLlmBrief(baseRequest, runner);
    expect(result).toBeNull();
  });

  it("returns null when the LLM runner throws", async () => {
    const runner = {
      run: async () => {
        throw new Error("LLM unavailable");
      },
    };
    const result = await generateLlmBrief(baseRequest, runner);
    expect(result).toBeNull();
  });

  it("injects the canonical tenant_id from the request, not from the LLM response", async () => {
    const runner = new StubLlmCallRunner({
      "intel-brief.generate-structured": VALID_LLM_BRIEF_JSON("wrong-tenant"),
    });
    const result = await generateLlmBrief(baseRequest, runner);
    expect(result?.tenant_id).toBe(TENANT_ID);
  });

  it("injects experiment lineage from the request, never from the LLM", async () => {
    const experimentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const request = intelBriefRequestedV1Schema.parse(
      makeValidRequest({ experiment_id: experimentId }),
    );
    const runner = new StubLlmCallRunner({
      "intel-brief.generate-structured": JSON.stringify({
        ...JSON.parse(VALID_LLM_BRIEF_JSON(TENANT_ID)),
        experiment_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
    });

    expect((await generateLlmBrief(request, runner))?.experiment_id).toBe(
      experimentId,
    );
  });
});

// ---------------------------------------------------------------------------
// IntelDirectorWorker — LLM-backed integration path
// ---------------------------------------------------------------------------

describe("IntelDirectorWorker (LLM path)", () => {
  const makeWorkerWithLlm = (
    stubResponse: string = VALID_LLM_BRIEF_JSON(TENANT_ID),
  ) => {
    const outboxRepository = new InMemoryOutboxRepository();
    const events: Array<{ subject: string; payload: Record<string, unknown> }> =
      [];
    const eventPublisher: EventPublisher = {
      publish: vi.fn(async (subject, payload) => {
        events.push({ subject, payload });
      }),
    };
    const llmCallRunner = new StubLlmCallRunner({
      "intel-brief.generate-structured": stubResponse,
    });
    const worker = new IntelDirectorWorker({
      outboxRepository,
      eventPublisher,
      llmCallRunner,
    });
    return { worker, outboxRepository, events, llmCallRunner };
  };

  it("uses LLM brief when runner produces valid JSON", async () => {
    const { worker } = makeWorkerWithLlm();

    const result = await worker.processBriefRequest(makeValidRequest());

    expect(result._llmGenerated).toBe(true);
    expect(result.content_opportunities[0]?.title).toBe(
      "LLM-generated opportunity",
    );
  });

  it("falls back to deterministic brief when LLM returns invalid JSON", async () => {
    const { worker } = makeWorkerWithLlm("Not a JSON response");

    const result = await worker.processBriefRequest(makeValidRequest());

    expect(result._llmGenerated).toBe(false);
    expect(result.content_opportunities[0]?.title).toContain("Baseline");
  });

  it("leaves delivery to the durable outbox publisher", async () => {
    const { worker, events } = makeWorkerWithLlm();
    await worker.processBriefRequest(makeValidRequest());

    expect(events).toHaveLength(0);
  });

  it("records the LLM call in the runner's call history", async () => {
    const { worker, llmCallRunner } = makeWorkerWithLlm();
    await worker.processBriefRequest(makeValidRequest());

    expect(
      llmCallRunner.callsFor("intel-brief.generate-structured"),
    ).toHaveLength(1);
  });
});
