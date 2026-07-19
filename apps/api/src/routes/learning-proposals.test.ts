import {
  InMemoryLearningProposalRepository,
  InMemoryOutboxRepository,
  learningProposalApprovedEventType,
} from "@growthos/db";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";

const tenantA = "00000000-0000-4000-8000-000000000001";
const tenantB = "00000000-0000-4000-8000-000000000002";

const jsonHeaders = (
  tenantId: string,
  authorization?: string,
): Record<string, string> => ({
  "content-type": "application/json",
  "X-Tenant-Id": tenantId,
  ...(authorization ? { Authorization: authorization } : {}),
});

const seedProposal = async (
  repository: InMemoryLearningProposalRepository,
  tenantId = tenantA,
  proposalKey = "critique:proposal-1",
  status: "awaiting_evidence" | "requires_approval" = "requires_approval",
) => {
  const proposal = await repository.create(tenantId, {
    proposalKey,
    targetType: "blog_draft",
    targetId: "article-1",
    risk: "high",
    proposalPayload: { requestedChange: "Use proof-led opening copy." },
    createdBy: "learning-worker",
  });

  if (status === "requires_approval") {
    const evaluated = await repository.recordEvaluation(tenantId, proposal.id, {
      decision: "requires_approval",
      evidenceSnapshot: { samples: 48, confidence: 0.92 },
      evaluationSnapshot: { guardrailRegression: 0 },
      decisionReasons: ["High-risk copy change needs founder approval."],
    });
    if (!evaluated) throw new Error("Expected seed proposal evaluation.");
    return evaluated;
  }

  return proposal;
};

describe("/v1/learning-proposals", () => {
  it("lists founder-safe summaries and returns tenant-scoped proposal detail", async () => {
    const repository = new InMemoryLearningProposalRepository();
    const proposalA = await seedProposal(repository);
    await seedProposal(repository, tenantB, "critique:tenant-b");
    const app = createApp({ learningProposalRepository: repository });

    const list = await app.request(
      "http://localhost/v1/learning-proposals?status=requires_approval&limit=10",
      { headers: { "X-Tenant-Id": tenantA } },
    );
    expect(list.status).toBe(200);
    expect(list.headers.get("Cache-Control")).toBe("private, no-store");
    const listBody = (await list.json()) as {
      tenantId: string;
      total: number;
      items: Array<Record<string, unknown>>;
    };
    expect(listBody).toMatchObject({ tenantId: tenantA, total: 1 });
    expect(listBody.items[0]).toMatchObject({
      id: proposalA.id,
      status: "requires_approval",
    });
    expect(listBody.items[0]).not.toHaveProperty("proposalPayload");
    expect(listBody.items[0]).not.toHaveProperty("evidenceSnapshot");

    const detail = await app.request(
      `http://localhost/v1/learning-proposals/${proposalA.id}`,
      { headers: { "X-Tenant-Id": tenantA } },
    );
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      tenantId: tenantA,
      proposal: {
        id: proposalA.id,
        proposalPayload: { requestedChange: "Use proof-led opening copy." },
        evidenceSnapshot: { samples: 48 },
      },
    });

    const crossTenant = await app.request(
      `http://localhost/v1/learning-proposals/${proposalA.id}`,
      { headers: { "X-Tenant-Id": tenantB } },
    );
    expect(crossTenant.status).toBe(404);

    const malformedId = await app.request(
      "http://localhost/v1/learning-proposals/not-a-proposal-id",
      { headers: { "X-Tenant-Id": tenantA } },
    );
    expect(malformedId.status).toBe(400);

    const badStatus = await app.request(
      "http://localhost/v1/learning-proposals?status=unknown",
      { headers: { "X-Tenant-Id": tenantA } },
    );
    expect(badStatus.status).toBe(400);
  });

  it("atomically approves a proposal and queues the learning-worker recheck event", async () => {
    const outbox = new InMemoryOutboxRepository();
    const repository = new InMemoryLearningProposalRepository(outbox);
    const proposal = await seedProposal(repository);
    const app = createApp({ learningProposalRepository: repository });

    const tenantSpoof = await app.request(
      `http://localhost/v1/learning-proposals/${proposal.id}/approve`,
      {
        method: "POST",
        headers: jsonHeaders(tenantA),
        body: JSON.stringify({
          approvedBy: "founder@example.test",
          tenantId: tenantB,
        }),
      },
    );
    expect(tenantSpoof.status).toBe(400);
    expect((await repository.getById(tenantA, proposal.id))?.status).toBe(
      "requires_approval",
    );

    const approval = await app.request(
      `http://localhost/v1/learning-proposals/${proposal.id}/approve`,
      {
        method: "POST",
        headers: jsonHeaders(tenantA),
        body: JSON.stringify({ approvedBy: "founder@example.test" }),
      },
    );
    expect(approval.status).toBe(200);
    const approvalBody = (await approval.json()) as {
      proposal: { status: string; humanApprovedBy: string };
      approvalEvent: { eventType: string; idempotencyKey: string };
    };
    expect(approvalBody).toMatchObject({
      proposal: {
        status: "approved",
        humanApprovedBy: "founder@example.test",
      },
      approvalEvent: {
        eventType: learningProposalApprovedEventType,
        idempotencyKey: `learning-proposal-approved:${proposal.id}`,
      },
    });

    const events = await outbox.listUnconsumed(tenantA, 10);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: learningProposalApprovedEventType,
      payload: { proposal_id: proposal.id },
    });

    const repeatApproval = await app.request(
      `http://localhost/v1/learning-proposals/${proposal.id}/approve`,
      {
        method: "POST",
        headers: jsonHeaders(tenantA),
        body: JSON.stringify({ approvedBy: "founder@example.test" }),
      },
    );
    expect(repeatApproval.status).toBe(409);
    expect(await outbox.listUnconsumed(tenantA, 10)).toHaveLength(1);
  });

  it("returns 404 for unknown or cross-tenant approvals and 409 for an invalid lifecycle state", async () => {
    const repository = new InMemoryLearningProposalRepository();
    const awaitingProposal = await seedProposal(
      repository,
      tenantA,
      "critique:awaiting",
      "awaiting_evidence",
    );
    const tenantBProposal = await seedProposal(repository, tenantB);
    const app = createApp({ learningProposalRepository: repository });

    const invalidState = await app.request(
      `http://localhost/v1/learning-proposals/${awaitingProposal.id}/approve`,
      {
        method: "POST",
        headers: jsonHeaders(tenantA),
        body: JSON.stringify({ approvedBy: "founder@example.test" }),
      },
    );
    expect(invalidState.status).toBe(409);

    const crossTenant = await app.request(
      `http://localhost/v1/learning-proposals/${tenantBProposal.id}/approve`,
      {
        method: "POST",
        headers: jsonHeaders(tenantA),
        body: JSON.stringify({ approvedBy: "founder@example.test" }),
      },
    );
    expect(crossTenant.status).toBe(404);

    const unknown = await app.request(
      "http://localhost/v1/learning-proposals/00000000-0000-4000-8000-000000000999/approve",
      {
        method: "POST",
        headers: jsonHeaders(tenantA),
        body: JSON.stringify({ approvedBy: "founder@example.test" }),
      },
    );
    expect(unknown.status).toBe(404);
  });

  it("requires API service authentication for reads and approvals when configured", async () => {
    const apiServiceToken = "learning-proposal-service-token";
    const repository = new InMemoryLearningProposalRepository();
    const proposal = await seedProposal(repository);
    const app = createApp({
      apiServiceToken,
      learningProposalRepository: repository,
    });

    const unauthenticatedRead = await app.request(
      "http://localhost/v1/learning-proposals",
      { headers: { "X-Tenant-Id": tenantA } },
    );
    expect(unauthenticatedRead.status).toBe(401);

    const unauthenticatedApproval = await app.request(
      `http://localhost/v1/learning-proposals/${proposal.id}/approve`,
      {
        method: "POST",
        headers: jsonHeaders(tenantA),
        body: JSON.stringify({ approvedBy: "founder@example.test" }),
      },
    );
    expect(unauthenticatedApproval.status).toBe(401);

    const authorizedRead = await app.request(
      "http://localhost/v1/learning-proposals",
      {
        headers: {
          "X-Tenant-Id": tenantA,
          Authorization: `Bearer ${apiServiceToken}`,
        },
      },
    );
    expect(authorizedRead.status).toBe(200);
  });

  it("returns 503 when the durable learning proposal store is unavailable", async () => {
    const app = createApp({ learningProposalRepository: null });

    const response = await app.request(
      "http://localhost/v1/learning-proposals",
      { headers: { "X-Tenant-Id": tenantA } },
    );
    expect(response.status).toBe(503);
  });
});
