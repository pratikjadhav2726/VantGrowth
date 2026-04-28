import { intelBriefV1Schema } from "@growthos/core";
import { InMemoryOutboxRepository } from "@growthos/db";
import { describe, expect, it, vi } from "vitest";
import {
  type EventPublisher,
  IntelDirectorWorker,
  generateDeterministicBrief,
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

  it("enqueues intel_brief.v1 in outbox and publishes to NATS", async () => {
    const publishFn = vi.fn(async () => undefined);
    const { worker, outboxRepository } = makeWorker(publishFn);

    const result = await worker.processBriefRequest(makeValidRequest());

    expect(result.schema_version).toBe("intel_brief.v1");
    expect(result.tenant_id).toBe(TENANT_ID);

    const events = await outboxRepository.listUnconsumed(TENANT_ID, 10);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("intel_brief.v1");

    expect(publishFn).toHaveBeenCalledOnce();
    expect(publishFn).toHaveBeenCalledWith(
      `t.${TENANT_ID}.intel_brief.v1`,
      expect.objectContaining({ schema_version: "intel_brief.v1" }),
    );
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
