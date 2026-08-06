import {
  InMemoryExperimentRepository,
  InMemoryLearningProposalRepository,
  InMemoryOutboxRepository,
  InMemoryPlaybookVersionsRepository,
  PostgresPromotionEvidenceProvider,
  learningProposalApprovedEventType,
} from "@growthos/db";
import { LearningWorker } from "@growthos/worker-learning";
import { describe, expect, it } from "vitest";

const tenantId = "00000000-0000-4000-8000-000000000001";

describe("adaptive learning approval loop", () => {
  it("re-reads immutable A/B evidence after approval and promotes exactly one playbook version", async () => {
    const experiments = new InMemoryExperimentRepository();
    const outbox = new InMemoryOutboxRepository();
    const proposals = new InMemoryLearningProposalRepository(outbox);
    const playbooks = new InMemoryPlaybookVersionsRepository();

    const experiment = await experiments.create(tenantId, {
      experimentKey: "blog-cta-lift-v1",
      motion: "content_led_growth",
      experimentType: "blog_call_to_action",
      unitType: "account",
      hypothesis: "A proof-led CTA increases qualified activation.",
      variantA: { cta: "Learn more" },
      variantB: { cta: "See the proof" },
      metricName: "qualified_activation_rate",
      metricDirection: "increase",
      minSampleSize: 20,
      initialStatus: "running",
      createdBy: "infra-smoke",
    });

    // Persist twenty immutable outcomes across twenty distinct accounts. The
    // values clear the policy evidence, confidence, and lift thresholds.
    for (const [variant, metricValue] of [
      ["a", 0.1],
      ["b", 0.2],
    ] as const) {
      for (let index = 0; index < 10; index += 1) {
        const entityId = `account-${variant}-${index}`;
        const assignment = await experiments.assign(tenantId, {
          experimentId: experiment.id,
          entityType: "account",
          entityId,
          variant,
          assignmentContext: { source: "adaptive-loop-smoke" },
        });
        await experiments.recordOutcome(tenantId, {
          experimentId: experiment.id,
          assignmentId: assignment.assignment.id,
          idempotencyKey: `outcome-${variant}-${index}`,
          entityType: "account",
          entityId,
          variant,
          metricName: experiment.metricName,
          metricValue,
          attributionConfidence: 0.92,
          attributionModel: "experiment_attribution_v1",
          source: "adaptive-loop-smoke",
          observedOutcome: { qualifiedActivation: metricValue > 0 },
          evidence: { accountId: entityId },
        });
      }
    }

    let evidenceReads = 0;
    const summarizeEvidence = experiments.summarizeEvidence.bind(experiments);
    experiments.summarizeEvidence = async (
      scopedTenantId,
      experimentId,
      metricName,
      guardrailMetricName,
    ) => {
      evidenceReads += 1;
      return summarizeEvidence(
        scopedTenantId,
        experimentId,
        metricName,
        guardrailMetricName,
      );
    };

    const evidenceProvider = new PostgresPromotionEvidenceProvider(
      proposals,
      experiments,
    );
    const worker = new LearningWorker({
      outboxRepository: outbox,
      playbookRepository: playbooks,
      learningProposalRepository: proposals,
      promotionEvidenceProvider: evidenceProvider,
    });
    const critique = {
      critique_id: "crit-adaptive-loop-0001",
      source: "worker-critique",
      artifact_kind: "blog_draft.v1",
      artifact_id: "draft-adaptive-loop-0001",
      experiment_id: experiment.id,
      change_risk: "high" as const,
      prompt_version: "prompt-v1",
      verdict: "revise" as const,
      confidence_score: 0.91,
      reasons: ["Opening needs a concrete proof point."],
      critiqued_at: "2026-07-19T12:00:00.000Z",
    };

    // High-risk changes may meet every evidence threshold but must not mutate
    // a playbook before a founder approval is durably recorded.
    expect(await worker.processFromCritique(tenantId, critique)).toBeNull();
    expect(evidenceReads).toBe(1);
    expect(await playbooks.getActive(tenantId, "blog_draft")).toBeNull();

    const proposal = await proposals.getByProposalKey(
      tenantId,
      `critique:${critique.critique_id}`,
    );
    expect(proposal).toMatchObject({
      experimentId: experiment.id,
      risk: "high",
      status: "requires_approval",
    });
    if (!proposal) throw new Error("Expected persisted learning proposal.");

    const approved = await proposals.approveAndEnqueue(
      tenantId,
      proposal.id,
      "founder@example.test",
    );
    expect(approved?.outboxEvent).toMatchObject({
      eventType: learningProposalApprovedEventType,
      payload: { proposal_id: proposal.id },
    });
    if (!approved) throw new Error("Expected durable founder approval.");

    const approvalRequest = approved.outboxEvent.payload.proposal_id;
    expect(approvalRequest).toBe(proposal.id);
    if (typeof approvalRequest !== "string") {
      throw new Error("Expected string proposal_id in approval request.");
    }

    const promoted = await worker.processApprovedProposal(
      tenantId,
      approvalRequest,
    );
    expect(promoted).not.toBeNull();
    expect(evidenceReads).toBe(2);
    expect(await playbooks.listAll(tenantId, "blog_draft")).toHaveLength(1);
    expect(await proposals.getById(tenantId, proposal.id)).toMatchObject({
      status: "promoted",
      promotedVersionRef: promoted?.id,
    });

    // Replaying the same durable approval request is safe: the promoted
    // lifecycle state prevents another version or downstream update event.
    expect(
      await worker.processApprovedProposal(tenantId, approvalRequest),
    ).toBeNull();
    expect(await playbooks.listAll(tenantId, "blog_draft")).toHaveLength(1);
    const updateEvents = await outbox.listByEventType(
      tenantId,
      "learning.playbook.updated.v1",
      10,
    );
    expect(updateEvents).toHaveLength(1);
  });
});
