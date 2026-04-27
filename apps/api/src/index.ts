import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { eventOutboxCommandSchema, motionScoringInputSchema, scoreMotions } from "@growthos/core";

const app = new Hono();

app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "@growthos/api"
  })
);

app.post("/v1/motions/score", async (c) => {
  const payload = motionScoringInputSchema.parse(await c.req.json());
  const result = scoreMotions(payload);
  return c.json(result, 202);
});

app.post("/v1/commands/outbox", async (c) => {
  const payload = eventOutboxCommandSchema.parse(await c.req.json());

  // This endpoint models async-by-default behavior: accept command, return tracking handle.
  return c.json(
    {
      accepted: true,
      trackingId: `${payload.tenantId}:${payload.idempotencyKey}`,
      enqueuedAt: new Date().toISOString()
    },
    202
  );
});

serve(
  {
    fetch: app.fetch,
    port: Number(process.env.PORT ?? 3001)
  }
);

console.log("@growthos/api listening on 3001 (default)");
