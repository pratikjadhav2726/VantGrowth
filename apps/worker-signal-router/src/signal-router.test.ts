import { InMemoryOutboxRepository } from "@growthos/db";
import { StubLlmCallRunner } from "@growthos/llm-harness";
import { describe, expect, it, vi } from "vitest";
import { gradeSignal } from "./signal-quality-grader.js";
import {
  type EventPublisher,
  SignalRouter,
  classifySignal,
} from "./signal-router.js";

const tenantId = "00000000-0000-4000-8000-000000000001";

const baseSignal = {
  tenantId,
  signalId: "sig-1",
  dedupeKey: "sig-1",
  source: "competitor.watch",
  kind: "competitor.pricing_change",
  payload: { competitor: "LaunchDarkly", change: "dropped pricing tier" },
};

const VALID_GRADE_JSON = JSON.stringify({
  relevance: 0.9,
  urgency: "high",
  topic_category: "competitor_pricing",
  action_recommendations: [
    "Update pricing page messaging",
    "Brief sales team on competitive positioning",
  ],
});

describe("classifySignal", () => {
  it("routes known high-value signals deterministically", () => {
    const result = classifySignal({
      tenantId,
      signalId: "sig-1",
      dedupeKey: "sig-1",
      source: "webhook.hubspot",
      kind: "prospect.replied",
      payload: {},
    });

    expect(result.priority).toBe("P0");
    expect(result.targetAgent).toBe("warm_outbound_researcher");
  });
});

// ---------------------------------------------------------------------------
// SignalRouter — baseline
// ---------------------------------------------------------------------------

describe("SignalRouter (no LLM)", () => {
  it("emits routed signal to outbox and tenant-scoped NATS subject", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const eventPublisher: EventPublisher = {
      publish: vi.fn(async () => undefined),
    };

    const router = new SignalRouter({ outboxRepository, eventPublisher });
    const routed = await router.route(baseSignal);

    expect(routed.priority).toBe("P1");
    expect(eventPublisher.publish).toHaveBeenCalledWith(
      `t.${tenantId}.signal.routed.v1`,
      expect.objectContaining({
        signal_id: "sig-1",
        target_agent: "intel_director",
      }),
    );

    const events = await outboxRepository.listUnconsumed(tenantId, 10);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("signal.routed.v1");
  });

  it("keeps outbox idempotent across duplicate signal deliveries", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const router = new SignalRouter({
      outboxRepository,
      eventPublisher: { publish: vi.fn(async () => undefined) },
    });

    await router.route(baseSignal);
    await router.route(baseSignal);

    const events = await outboxRepository.listUnconsumed(tenantId, 10);
    expect(events).toHaveLength(1);
  });

  it("does not include grade field when no runner is configured", async () => {
    const router = new SignalRouter({
      outboxRepository: new InMemoryOutboxRepository(),
      eventPublisher: { publish: vi.fn(async () => undefined) },
    });

    const routed = await router.route(baseSignal);
    expect(routed.grade).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// gradeSignal — unit tests
// ---------------------------------------------------------------------------

describe("gradeSignal", () => {
  it("returns a parsed SignalGrade when LLM returns valid JSON (snake_case keys)", async () => {
    const runner = new StubLlmCallRunner({
      "signal.grade": VALID_GRADE_JSON,
    });

    const grade = await gradeSignal(baseSignal, runner);

    expect(grade).not.toBeNull();
    expect(grade?.relevance).toBe(0.9);
    expect(grade?.urgency).toBe("high");
    expect(grade?.topicCategory).toBe("competitor_pricing");
    expect(grade?.actionRecommendations).toHaveLength(2);
  });

  it("returns a parsed SignalGrade when LLM returns camelCase keys", async () => {
    const runner = new StubLlmCallRunner({
      "signal.grade": JSON.stringify({
        relevance: 0.7,
        urgency: "medium",
        topicCategory: "feature_launch",
        actionRecommendations: ["Monitor closely"],
      }),
    });

    const grade = await gradeSignal(baseSignal, runner);

    expect(grade?.topicCategory).toBe("feature_launch");
    expect(grade?.actionRecommendations).toEqual(["Monitor closely"]);
  });

  it("returns null when LLM response contains no JSON", async () => {
    const runner = new StubLlmCallRunner({
      "signal.grade": "Unable to grade this signal.",
    });

    const grade = await gradeSignal(baseSignal, runner);
    expect(grade).toBeNull();
  });

  it("returns null when LLM JSON is missing required fields", async () => {
    const runner = new StubLlmCallRunner({
      "signal.grade": JSON.stringify({ relevance: 0.5 }),
    });

    const grade = await gradeSignal(baseSignal, runner);
    expect(grade).toBeNull();
  });

  it("returns null when runner throws", async () => {
    const failingRunner = {
      run: async () => {
        throw new Error("LLM unavailable");
      },
    };
    const grade = await gradeSignal(baseSignal, failingRunner);
    expect(grade).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SignalRouter — LLM grading integration
// ---------------------------------------------------------------------------

describe("SignalRouter (with LLM grading)", () => {
  it("enriches routed signal with grade when runner returns valid JSON", async () => {
    const outboxRepository = new InMemoryOutboxRepository();
    const published: Array<{
      subject: string;
      payload: Record<string, unknown>;
    }> = [];

    const router = new SignalRouter({
      outboxRepository,
      eventPublisher: {
        publish: vi.fn(async (s, p) => {
          published.push({ subject: s, payload: p });
        }),
      },
      llmCallRunner: new StubLlmCallRunner({
        "signal.grade": VALID_GRADE_JSON,
      }),
      motionContext: "inbound_content, plg",
    });

    const routed = await router.route(baseSignal);

    expect(routed.grade?.relevance).toBe(0.9);
    expect(routed.grade?.urgency).toBe("high");

    const publishedPayload = published[0]?.payload;
    expect(publishedPayload?.grade).toMatchObject({
      relevance: 0.9,
      topic_category: "competitor_pricing",
    });
  });

  it("routes successfully without grade when LLM returns invalid JSON", async () => {
    const router = new SignalRouter({
      outboxRepository: new InMemoryOutboxRepository(),
      eventPublisher: { publish: vi.fn(async () => undefined) },
      llmCallRunner: new StubLlmCallRunner({ "signal.grade": "not json" }),
    });

    const routed = await router.route(baseSignal);

    expect(routed.priority).toBe("P1");
    expect(routed.grade).toBeUndefined();
  });

  it("records LLM call in runner history for observability", async () => {
    const runner = new StubLlmCallRunner({ "signal.grade": VALID_GRADE_JSON });
    const router = new SignalRouter({
      outboxRepository: new InMemoryOutboxRepository(),
      eventPublisher: { publish: vi.fn(async () => undefined) },
      llmCallRunner: runner,
    });

    await router.route(baseSignal);

    expect(runner.callsFor("signal.grade")).toHaveLength(1);
  });
});
