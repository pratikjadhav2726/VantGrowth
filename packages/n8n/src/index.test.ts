import { describe, expect, it, vi } from "vitest";
import {
  N8nDispatchClient,
  n8nDispatchRequestSchema,
  n8nSignalEnvelopeSchema,
  signN8nPayload,
  verifyN8nSignature,
} from "./index.js";

const dispatchRequest = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  actionId: "act_1",
  actionType: "send_email",
  approvedBy: "founder",
  idempotencyKey: "dispatch-act-1",
  payload: { subject: "Hello" },
};

describe("n8n contracts", () => {
  it("validates signal envelopes", () => {
    const parsed = n8nSignalEnvelopeSchema.parse({
      eventId: "evt_1",
      source: "hubspot",
      signalType: "icp",
      occurredAt: "2026-07-06T07:00:00.000Z",
      workflowId: "wf_1",
      executionId: "exec_1",
      payload: { accountId: "acct_1" },
    });

    expect(parsed.eventId).toBe("evt_1");
  });

  it("rejects invalid signal envelopes", () => {
    expect(() =>
      n8nSignalEnvelopeSchema.parse({
        eventId: "evt_1",
        source: "hubspot",
        signalType: "unknown",
        occurredAt: "2026-07-06T07:00:00.000Z",
        payload: {},
      }),
    ).toThrow();
  });

  it("validates dispatch requests", () => {
    expect(n8nDispatchRequestSchema.parse(dispatchRequest).actionType).toBe(
      "send_email",
    );
  });
});

describe("verifyN8nSignature", () => {
  it("accepts valid hex signatures", () => {
    const body = JSON.stringify({ hello: "world" });
    const signature = signN8nPayload(body, "secret");

    expect(verifyN8nSignature(body, signature, "secret")).toBe(true);
  });

  it("accepts sha256-prefixed signatures", () => {
    const body = JSON.stringify({ hello: "world" });
    const signature = `sha256=${signN8nPayload(body, "secret")}`;

    expect(verifyN8nSignature(body, signature, "secret")).toBe(true);
  });

  it("rejects invalid signatures without throwing", () => {
    const body = JSON.stringify({ hello: "world" });

    expect(verifyN8nSignature(body, "not-a-signature", "secret")).toBe(false);
    expect(verifyN8nSignature(body, "0".repeat(64), "secret")).toBe(false);
  });
});

describe("N8nDispatchClient", () => {
  it("posts dispatch payloads with idempotency key", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ received: true }), { status: 200 }),
    ) as unknown as typeof fetch;
    const client = new N8nDispatchClient(
      { webhookUrl: "https://n8n.example/webhook/dispatch" },
      fetchImpl,
    );

    const result = await client.dispatch(dispatchRequest);

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://n8n.example/webhook/dispatch",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "idempotency-key": "dispatch-act-1",
        }),
      }),
    );
  });

  it("returns non-retryable failures for 4xx responses", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "bad request" }), { status: 400 }),
    ) as unknown as typeof fetch;
    const client = new N8nDispatchClient(
      { webhookUrl: "https://n8n.example/webhook/dispatch" },
      fetchImpl,
    );

    const result = await client.dispatch(dispatchRequest);

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      retryable: false,
    });
  });

  it("returns retryable failures for 5xx responses", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("oops", { status: 503 }),
    ) as unknown as typeof fetch;
    const client = new N8nDispatchClient(
      { webhookUrl: "https://n8n.example/webhook/dispatch" },
      fetchImpl,
    );

    const result = await client.dispatch(dispatchRequest);

    expect(result).toMatchObject({
      ok: false,
      status: 503,
      retryable: true,
    });
  });

  it("returns retryable failures on network errors", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const client = new N8nDispatchClient(
      { webhookUrl: "https://n8n.example/webhook/dispatch" },
      fetchImpl,
    );

    const result = await client.dispatch(dispatchRequest);

    expect(result).toMatchObject({
      ok: false,
      status: null,
      retryable: true,
    });
  });

  it("returns retryable failures on timeout", async () => {
    const fetchImpl = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            );
          });
        }),
    ) as unknown as typeof fetch;
    const client = new N8nDispatchClient(
      {
        webhookUrl: "https://n8n.example/webhook/dispatch",
        timeoutMs: 1,
      },
      fetchImpl,
    );

    const result = await client.dispatch(dispatchRequest);

    expect(result).toMatchObject({
      ok: false,
      status: null,
      retryable: true,
      body: { reason: "timeout" },
    });
  });
});
