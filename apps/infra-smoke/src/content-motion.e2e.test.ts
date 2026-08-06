import {
  InMemoryOutboxRepository,
  InMemorySignalEventsRepository,
} from "@growthos/db";
import { BlogDraftWorker } from "@growthos/worker-blog-draft";
import { ContentStrategistWorker } from "@growthos/worker-content-strategist";
import {
  CritiqueWorker,
  createBlogDraftCritiqueRequest,
} from "@growthos/worker-critique";
import { IntelDirectorWorker } from "@growthos/worker-intel-director";
import { LearningWorker } from "@growthos/worker-learning";
import {
  SignalIngestionWorker,
  SignalRouter,
} from "@growthos/worker-signal-router";
import { describe, expect, it } from "vitest";

const tenantId = "00000000-0000-4000-8000-000000000001";
const experimentId = "00000000-0000-4000-8000-000000000099";

describe("durable content motion", () => {
  it("takes a persisted market signal through intel, content, draft, critique, and learning", async () => {
    const outbox = new InMemoryOutboxRepository();
    const signals = new InMemorySignalEventsRepository();
    const signalRouter = new SignalRouter({ outboxRepository: outbox });
    const ingestionWorker = new SignalIngestionWorker({
      signalEventsRepository: signals,
      outboxRepository: outbox,
      signalRouter,
    });

    const ingested = await signals.ingest({
      tenantId,
      signalType: "competitive",
      source: "market-monitor",
      externalId: "acme-pricing-2026-07-19",
      payload: {
        kind: "competitor.pricing_change",
        competitor: "Acme",
        summary:
          "Acme introduced a lower self-serve tier for growing B2B teams.",
        source_url: "https://example.test/acme-pricing",
        experiment_id: experimentId,
      },
    });

    const firstRoute = await ingestionWorker.processTenant(tenantId, 10);
    const replayRoute = await ingestionWorker.processTenant(tenantId, 10);
    expect(firstRoute.processedSignalIds).toEqual([ingested.event.id.toString()]);
    expect(replayRoute.processedSignalIds).toHaveLength(0);
    expect(firstRoute.failures).toHaveLength(0);

    const routedEvents = await outbox.listByEventType(
      tenantId,
      "signal.routed.v1",
      10,
    );
    const intelRequests = await outbox.listByEventType(
      tenantId,
      "intel_brief.requested.v1",
      10,
    );
    expect(routedEvents).toHaveLength(1);
    expect(intelRequests).toHaveLength(1);
    expect(intelRequests[0]?.payload).toMatchObject({
      tenant_id: tenantId,
      experiment_id: experimentId,
      trigger: {
        signal_id: ingested.event.id.toString(),
        kind: "competitor.pricing_change",
      },
    });

    const intelDirector = new IntelDirectorWorker({ outboxRepository: outbox });
    await intelDirector.processBriefRequest(intelRequests[0]?.payload);
    const intelBriefs = await outbox.listByEventType(
      tenantId,
      "intel_brief.v1",
      10,
    );
    expect(intelBriefs).toHaveLength(1);
    expect(intelBriefs[0]?.payload).toMatchObject({
      tenant_id: tenantId,
      experiment_id: experimentId,
      competitive_signals: [
        {
          competitor: "Acme",
          signal_type: "pricing_change",
        },
      ],
    });

    const contentStrategist = new ContentStrategistWorker({
      outboxRepository: outbox,
    });
    await contentStrategist.processBrief(intelBriefs[0]?.payload);
    const contentOpportunities = await outbox.listByEventType(
      tenantId,
      "content_opportunity.v1",
      10,
    );
    const contentBriefs = await outbox.listByEventType(
      tenantId,
      "content_brief.v1",
      10,
    );
    expect(contentOpportunities).toHaveLength(1);
    expect(contentOpportunities[0]?.payload).toMatchObject({
      tenant_id: tenantId,
      experiment_id: experimentId,
      evidence: [
        {
          type: "competitor_move",
          source_url: "https://example.test/acme-pricing",
        },
      ],
    });
    expect(contentBriefs).toHaveLength(1);
    expect(contentBriefs[0]?.payload.experiment_id).toBe(experimentId);

    const blogDraftWorker = new BlogDraftWorker({ outboxRepository: outbox });
    await blogDraftWorker.processBrief(contentBriefs[0]?.payload);
    const drafts = await outbox.listByEventType(tenantId, "blog_draft.v1", 10);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.payload).toMatchObject({
      tenant_id: tenantId,
      experiment_id: experimentId,
      status: "draft",
    });

    const critiqueWorker = new CritiqueWorker({ outboxRepository: outbox });
    await critiqueWorker.critique(
      createBlogDraftCritiqueRequest(drafts[0]?.payload),
    );
    const critiques = await outbox.listByEventType(
      tenantId,
      "critique.completed.v1",
      10,
    );
    expect(critiques).toHaveLength(1);
    expect(critiques[0]?.payload).toMatchObject({
      artifact_kind: "blog_draft.v1",
      artifact_id: drafts[0]?.payload.draft_id,
      experiment_id: experimentId,
    });

    const learningWorker = new LearningWorker({ outboxRepository: outbox });
    await learningWorker.processFromCritique(tenantId, critiques[0]?.payload);
    await learningWorker.process({
      tenantId,
      learningId: "founder-decision-1",
      dedupeKey: "founder-decision-1",
      source: "founder_approval",
      issueId: "00000000-0000-4000-8000-000000000011",
      outputType: "blog_draft.v1",
      action: "rejected",
      rubricFailures: ["Missing a verifiable source citation"],
      learnOptIn: true,
    });
    const learningCandidates = await outbox.listByEventType(
      tenantId,
      "learning.candidate.synthesized.v1",
      10,
    );
    expect(learningCandidates).toHaveLength(1);
    expect(learningCandidates[0]?.payload).toMatchObject({
      source: "founder_approval",
      disposition: "candidate",
      priority: "high",
    });
  });
});
