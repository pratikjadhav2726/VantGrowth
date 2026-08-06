import { describe, expect, it } from "vitest";
import {
  InMemoryComponentHealthRepository,
  InMemoryExperimentRepository,
  InMemoryIncidentRepository,
  InMemoryLearningProposalRepository,
  PostgresPromotionEvidenceProvider,
  learningProposalApprovedEventType,
  toIncidentSummary,
} from "./adaptive-control-plane-repository.js";
import { InMemoryOutboxRepository } from "./outbox-repository.js";

const TENANT_A = "00000000-0000-4000-8000-000000000010";
const TENANT_B = "00000000-0000-4000-8000-000000000011";

const createExperiment = async (
  repository: InMemoryExperimentRepository,
  tenantId = TENANT_A,
  experimentKey = "onboarding-copy-v1",
) =>
  repository.create(tenantId, {
    experimentKey,
    motion: "lifecycle",
    experimentType: "message_variant",
    unitType: "account",
    hypothesis: "A concrete activation promise improves qualified activation.",
    variantA: { subject: "Get started" },
    variantB: { subject: "Activate your workspace" },
    metricName: "qualified_activation_rate",
    metricDirection: "increase",
    minSampleSize: 20,
    createdBy: "test",
  });

describe("InMemoryExperimentRepository", () => {
  it("makes creation and unit assignment idempotent within a tenant", async () => {
    const repository = new InMemoryExperimentRepository();
    const first = await createExperiment(repository);
    const duplicate = await createExperiment(repository);
    expect(duplicate.id).toBe(first.id);

    await repository.transition(TENANT_A, first.id, "draft", "running");
    const assignment = await repository.assign(TENANT_A, {
      experimentId: first.id,
      entityType: "account",
      entityId: "acct-1",
      variant: "a",
      assignmentContext: { segment: "startup" },
    });
    const replay = await repository.assign(TENANT_A, {
      experimentId: first.id,
      entityType: "account",
      entityId: "acct-1",
      // A redelivery must return the original sticky treatment, not flip it.
      variant: "b",
    });

    expect(assignment.isExisting).toBe(false);
    expect(replay.isExisting).toBe(true);
    expect(replay.assignment.id).toBe(assignment.assignment.id);
    expect(replay.assignment.variant).toBe("a");
  });

  it("guards state transitions and prevents cross-tenant reads", async () => {
    const repository = new InMemoryExperimentRepository();
    const experiment = await createExperiment(repository);

    await expect(
      repository.transition(TENANT_A, experiment.id, "draft", "promoted"),
    ).rejects.toThrow("Illegal experiment transition");
    expect(await repository.getById(TENANT_B, experiment.id)).toBeNull();
    expect(
      await repository.transition(TENANT_B, experiment.id, "draft", "running"),
    ).toBeNull();
  });

  it("persists immutable, idempotent observations only after an experiment runs", async () => {
    const repository = new InMemoryExperimentRepository();
    const experiment = await createExperiment(repository);
    await expect(
      repository.recordObservation(TENANT_A, {
        experimentId: experiment.id,
        idempotencyKey: "outcome-1",
        entityType: "account",
        entityId: "acct-1",
        variant: "a",
        metricName: experiment.metricName,
        metricValue: 1,
        attributionConfidence: 0.9,
        attributionModel: "direct",
        source: "product",
      }),
    ).rejects.toThrow("Observations require");

    await repository.transition(TENANT_A, experiment.id, "draft", "running");
    const assignment = await repository.assign(TENANT_A, {
      experimentId: experiment.id,
      entityType: "account",
      entityId: "acct-1",
      variant: "a",
    });
    const first = await repository.recordOutcome(TENANT_A, {
      experimentId: experiment.id,
      assignmentId: assignment.assignment.id,
      idempotencyKey: "outcome-1",
      entityType: "account",
      entityId: "acct-1",
      variant: "a",
      metricName: experiment.metricName,
      metricValue: 1,
      attributionConfidence: 0.9,
      attributionModel: "direct",
      source: "product",
      costAmount: 2.5,
      costCurrency: "usd",
      observedOutcome: { activated: true },
      evidence: { sourceEventId: "evt-1" },
    });
    const replay = await repository.recordOutcome(TENANT_A, {
      experimentId: experiment.id,
      assignmentId: assignment.assignment.id,
      idempotencyKey: "outcome-1",
      entityType: "account",
      entityId: "acct-1",
      variant: "a",
      metricName: experiment.metricName,
      metricValue: 0,
      attributionConfidence: 0.1,
      attributionModel: "untrusted",
      source: "replay",
    });

    expect(replay.id).toBe(first.id);
    expect(replay.metricValue).toBe(1);
    expect(replay.costCurrency).toBe("USD");
  });
});

describe("Promotion evidence and learning proposal lifecycle", () => {
  it("derives an evidence-gated evaluation from persisted A/B observations", async () => {
    const experiments = new InMemoryExperimentRepository();
    const proposals = new InMemoryLearningProposalRepository();
    const experiment = await createExperiment(experiments);
    await experiments.transition(TENANT_A, experiment.id, "draft", "running");

    for (const [entityId, variant, metricValue] of [
      ["a-1", "a", 0.1],
      ["a-2", "a", 0.1],
      ["b-1", "b", 0.2],
      ["b-2", "b", 0.2],
    ] as const) {
      await experiments.recordObservation(TENANT_A, {
        experimentId: experiment.id,
        idempotencyKey: `metric-${entityId}`,
        entityType: "account",
        entityId,
        variant,
        metricName: experiment.metricName,
        metricValue,
        attributionConfidence: 0.9,
        attributionModel: "multi_touch",
        source: "analytics",
      });
    }
    await experiments.recordObservation(TENANT_A, {
      experimentId: experiment.id,
      idempotencyKey: "guardrail-a",
      entityType: "account",
      entityId: "a-1",
      variant: "a",
      metricName: "unsubscribe_rate",
      metricValue: 0.01,
      isGuardrail: true,
      attributionConfidence: 0.9,
      attributionModel: "direct",
      source: "email",
    });
    await experiments.recordObservation(TENANT_A, {
      experimentId: experiment.id,
      idempotencyKey: "guardrail-b",
      entityType: "account",
      entityId: "b-1",
      variant: "b",
      metricName: "unsubscribe_rate",
      metricValue: 0.015,
      isGuardrail: true,
      attributionConfidence: 0.9,
      attributionModel: "direct",
      source: "email",
    });

    const proposal = await proposals.create(TENANT_A, {
      proposalKey: "critique:proposal-1",
      experimentId: experiment.id,
      targetType: "playbook",
      targetId: "onboarding-email",
      risk: "low",
      proposalPayload: { change: "use activation language" },
      createdBy: "learning-worker",
    });
    const provider = new PostgresPromotionEvidenceProvider(
      proposals,
      experiments,
      {
        guardrailMetricName: "unsubscribe_rate",
      },
    );
    const evaluation = await provider.getEvaluation({
      tenantId: TENANT_A,
      proposalId: proposal.proposalKey,
    });

    expect(evaluation).toMatchObject({
      proposalId: proposal.proposalKey,
      evidenceCount: 4,
      uniqueEntities: 4,
      confidence: 0.9,
      baselineMetric: 0.1,
      candidateMetric: 0.2,
    });
    expect(evaluation?.worstGuardrailRegression).toBeCloseTo(0.005);
  });

  it("requires an explicit approval/promotion/rollback sequence", async () => {
    const repository = new InMemoryLearningProposalRepository();
    const proposal = await repository.create(TENANT_A, {
      proposalKey: "proposal-high-risk",
      targetType: "playbook",
      targetId: "pricing-copy",
      risk: "high",
      proposalPayload: { change: "new claim" },
      createdBy: "learning-worker",
    });
    const evaluated = await repository.recordEvaluation(TENANT_A, proposal.id, {
      decision: "requires_approval",
      evidenceSnapshot: { observations: 30 },
      evaluationSnapshot: { confidence: 0.9 },
      decisionReasons: ["High risk requires founder approval."],
    });
    expect(evaluated?.status).toBe("requires_approval");
    expect(
      await repository.markPromoted(
        TENANT_A,
        proposal.id,
        "playbook:v2",
        "00000000-0000-4000-8000-0000000000aa",
      ),
    ).toBeNull();

    expect(
      (await repository.approve(TENANT_A, proposal.id, "founder"))?.status,
    ).toBe("approved");
    const claim = await repository.claimPromotion(TENANT_A, proposal.id);
    expect(claim).not.toBeNull();
    expect(
      (
        await repository.markPromoted(
          TENANT_A,
          proposal.id,
          "playbook:v2",
          claim?.token ?? "",
        )
      )?.status,
    ).toBe("promoted");
    expect(
      (await repository.markRolledBack(TENANT_A, proposal.id, "playbook:v1"))
        ?.status,
    ).toBe("rolled_back");
  });

  it("leases promotion to one consumer and recovers safely after expiry", async () => {
    const repository = new InMemoryLearningProposalRepository();
    const proposal = await repository.create(TENANT_A, {
      proposalKey: "proposal-promotion-lease",
      targetType: "playbook",
      targetId: "pricing-copy",
      risk: "low",
      proposalPayload: { change: "new claim" },
      createdBy: "learning-worker",
    });
    await repository.recordEvaluation(TENANT_A, proposal.id, {
      decision: "promote",
      evidenceSnapshot: { observations: 30 },
      evaluationSnapshot: { confidence: 0.9 },
      decisionReasons: ["Evidence passed promotion policy."],
    });

    // Start just ahead of wall time so the deterministic recovery clock does
    // not make the recovered claim appear expired to markPromoted().
    const claimedAt = new Date(Date.now() + 1_000);
    const [first, concurrent] = await Promise.all([
      repository.claimPromotion(TENANT_A, proposal.id, {
        now: claimedAt,
        leaseMs: 1_000,
      }),
      repository.claimPromotion(TENANT_A, proposal.id, {
        now: claimedAt,
        leaseMs: 1_000,
      }),
    ]);
    expect([first, concurrent].filter(Boolean)).toHaveLength(1);
    const firstClaim = first ?? concurrent;
    if (!firstClaim) throw new Error("Expected a promotion claim.");

    expect(
      await repository.claimPromotion(TENANT_A, proposal.id, {
        now: new Date(claimedAt.getTime() + 500),
        leaseMs: 1_000,
      }),
    ).toBeNull();

    // A worker that crashed after claiming cannot hold the proposal forever.
    const recoveredClaim = await repository.claimPromotion(
      TENANT_A,
      proposal.id,
      {
        now: new Date(claimedAt.getTime() + 1_001),
        leaseMs: 1_000,
      },
    );
    expect(recoveredClaim).not.toBeNull();
    if (!recoveredClaim) throw new Error("Expected an expired lease recovery.");

    // The stale claimant is fenced off; only the current claimant can finish.
    expect(
      await repository.markPromoted(
        TENANT_A,
        proposal.id,
        "playbook:stale",
        firstClaim.token,
      ),
    ).toBeNull();
    const promoted = await repository.markPromoted(
      TENANT_A,
      proposal.id,
      "playbook:recovered",
      recoveredClaim.token,
    );
    expect(promoted).toMatchObject({
      status: "promoted",
      promotedVersionRef: "playbook:recovered",
      promotionClaimToken: null,
      promotionClaimExpiresAt: null,
    });
  });

  it("atomically records founder approval with one durable learning recheck request", async () => {
    const outbox = new InMemoryOutboxRepository();
    const repository = new InMemoryLearningProposalRepository(outbox);
    const proposal = await repository.create(TENANT_A, {
      proposalKey: "proposal-approval-outbox",
      targetType: "playbook",
      targetId: "pricing-copy",
      risk: "high",
      proposalPayload: { change: "new claim" },
      createdBy: "learning-worker",
    });
    await repository.recordEvaluation(TENANT_A, proposal.id, {
      decision: "requires_approval",
      evidenceSnapshot: { observations: 30 },
      evaluationSnapshot: { confidence: 0.9 },
      decisionReasons: ["High risk requires founder approval."],
    });

    const approval = await repository.approveAndEnqueue(
      TENANT_A,
      proposal.id,
      "founder@example.test",
    );
    expect(approval?.proposal).toMatchObject({
      id: proposal.id,
      status: "approved",
      humanApprovedBy: "founder@example.test",
    });
    expect(approval?.outboxEvent).toMatchObject({
      tenantId: TENANT_A,
      eventType: learningProposalApprovedEventType,
      idempotencyKey: `learning-proposal-approved:${proposal.id}`,
      payload: { proposal_id: proposal.id },
    });

    const events = await outbox.listUnconsumed(TENANT_A, 10);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: learningProposalApprovedEventType,
      payload: { proposal_id: proposal.id },
    });

    // The proposal is no longer in an approval-eligible state, so a retry
    // cannot create a second downstream promotion request.
    expect(
      await repository.approveAndEnqueue(
        TENANT_A,
        proposal.id,
        "founder@example.test",
      ),
    ).toBeNull();
    expect(await outbox.listUnconsumed(TENANT_A, 10)).toHaveLength(1);
  });

  it("restores in-memory proposal state when durable approval enqueue fails", async () => {
    const repository = new InMemoryLearningProposalRepository({
      async enqueue() {
        throw new Error("outbox unavailable");
      },
    });
    const proposal = await repository.create(TENANT_A, {
      proposalKey: "proposal-approval-rollback",
      targetType: "playbook",
      targetId: "pricing-copy",
      risk: "high",
      proposalPayload: { change: "new claim" },
      createdBy: "learning-worker",
    });
    await repository.recordEvaluation(TENANT_A, proposal.id, {
      decision: "requires_approval",
      evidenceSnapshot: { observations: 30 },
      evaluationSnapshot: { confidence: 0.9 },
      decisionReasons: ["High risk requires founder approval."],
    });

    await expect(
      repository.approveAndEnqueue(TENANT_A, proposal.id, "founder"),
    ).rejects.toThrow("outbox unavailable");
    expect(await repository.getById(TENANT_A, proposal.id)).toMatchObject({
      status: "requires_approval",
      humanApprovedBy: null,
      humanApprovedAt: null,
    });
  });
});

describe("Component health and incidents", () => {
  it("keeps health decision history while returning the latest component state", async () => {
    const repository = new InMemoryComponentHealthRepository();
    const input = {
      componentId: "n8n",
      idempotencyKey: "health-1",
      state: "degraded" as const,
      errorRate: 0.2,
      consecutiveFailures: 3,
      p95LatencyMs: 2000,
      stalenessSeconds: 0,
      dependencyAvailable: true,
      fallbackAvailable: true,
      lastKnownGoodAvailable: true,
      recoveryAttempts: 1,
      guardrailBreached: false,
      action: "use_fallback" as const,
      allowExternalActions: true,
      retryAfterSeconds: 30,
      reasons: ["Error rate exceeds policy."],
    };
    const first = await repository.record(TENANT_A, input);
    const replay = await repository.record(TENANT_A, input);
    expect(replay.isDuplicate).toBe(true);
    expect(replay.health.id).toBe(first.health.id);

    await repository.record(TENANT_A, {
      ...input,
      idempotencyKey: "health-2",
      state: "healthy",
      errorRate: 0,
      consecutiveFailures: 0,
      action: "resume",
      retryAfterSeconds: undefined,
      reasons: ["Recovery checks passed."],
      observedAt: new Date(Date.now() + 1_000),
    });
    expect((await repository.getByComponent(TENANT_A, "n8n"))?.state).toBe(
      "healthy",
    );
    expect(await repository.listLatest(TENANT_B)).toEqual([]);
  });

  it("keeps diagnostics tenant-private in the founder-safe incident projection", async () => {
    const repository = new InMemoryIncidentRepository();
    const incident = await repository.create(TENANT_A, {
      incidentKey: "nats-outage-1",
      componentId: "nats",
      severity: "critical",
      title: "NATS unavailable",
      summary: "Outbound dispatch is paused.",
      action: "quarantine_and_escalate",
      diagnosticMetadata: { accessToken: "must-not-leak" },
    });
    const acknowledged = await repository.transition(
      TENANT_A,
      incident.id,
      "open",
      "acknowledged",
    );
    expect(acknowledged?.acknowledgedAt).not.toBeNull();
    const resolved = await repository.transition(
      TENANT_A,
      incident.id,
      "acknowledged",
      "resolved",
    );
    expect(resolved).not.toBeNull();
    if (!resolved) throw new Error("Expected incident resolution to succeed.");
    const summary = toIncidentSummary(resolved);

    expect(summary).not.toHaveProperty("diagnosticMetadata");
    expect(summary.resolvedAt).not.toBeNull();
  });
});
