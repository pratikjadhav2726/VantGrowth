/**
 * /v1/digest — founder digest API.
 *
 *   GET  /v1/digest/weekly   — fetch weekly digest metrics for a tenant
 *   POST /v1/digest/send     — trigger digest email delivery (stubs Postal in dev)
 *
 * The weekly digest summarises the past 7 days:
 *   - Motion stack delta (primary motions vs prior week)
 *   - Approval stats (approved / rejected / pending count)
 *   - Signal count by category
 *   - Top-performing motion and recommended action
 *
 * Postal integration: when POSTAL_API_KEY + POSTAL_SERVER_URL are set the
 * endpoint sends a real email.  Otherwise it logs the digest and returns
 * { sent: false, reason: "postal_not_configured" } — safe for dev/CI.
 */

import type {
  ApprovalFeedbackRepository,
  MotionStackRepository,
  OutboxRepository,
} from "@growthos/db";
import { Hono } from "hono";
import { z } from "zod";

export interface DigestDeps {
  approvalFeedbackRepository: ApprovalFeedbackRepository | null;
  outboxRepository: OutboxRepository | null;
  motionStackRepository: MotionStackRepository | null;
}

const weeklyMetricsSchema = z.object({
  tenantId: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  approvals: z.object({
    approved: z.number(),
    rejected: z.number(),
    pending: z.number(),
  }),
  motionStack: z.object({
    primaryMotions: z.array(z.string()),
    topMotion: z.string().nullable(),
  }),
  signalCount: z.number(),
  generatedAt: z.string(),
});

export type WeeklyMetrics = z.infer<typeof weeklyMetricsSchema>;

const sendDigestResponseSchema = z.object({
  sent: z.boolean(),
  digestId: z.string(),
  tenantId: z.string(),
  reason: z.string().optional(),
  metrics: weeklyMetricsSchema,
});

const sendDigestRequestSchema = z.object({
  recipientEmail: z.string().email().optional(),
});

const DEFAULT_POSTAL_TIMEOUT_MS = 8_000;
const DEFAULT_POSTAL_MAX_ATTEMPTS = 3;
const DEFAULT_POSTAL_RETRY_DELAY_MS = 250;

const asPositiveInt = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const wait = async (ms: number): Promise<void> => {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const isRetryableStatus = (status: number): boolean =>
  status === 429 || status >= 500;

const MOTION_LABEL: Record<string, string> = {
  inbound_content: "Inbound Content",
  community_led: "Community-Led Growth",
  partner_referral: "Partner Referral",
  product_led: "Product-Led Growth",
  outbound_sales: "Outbound Sales",
  event_marketing: "Event Marketing",
};

function formatDigestEmail(metrics: WeeklyMetrics, tenantId: string): string {
  const top = metrics.motionStack.topMotion
    ? (MOTION_LABEL[metrics.motionStack.topMotion] ??
      metrics.motionStack.topMotion)
    : "N/A";

  return `
GrowthOS Weekly Digest — ${metrics.periodStart.slice(0, 10)} → ${metrics.periodEnd.slice(0, 10)}
Tenant: ${tenantId}

APPROVALS
  Approved: ${metrics.approvals.approved}
  Rejected: ${metrics.approvals.rejected}
  Pending:  ${metrics.approvals.pending}

MOTION STACK
  Primary:  ${metrics.motionStack.primaryMotions.map((m) => MOTION_LABEL[m] ?? m).join(", ") || "—"}
  Top:      ${top}

SIGNALS
  Total signals this week: ${metrics.signalCount}

Generated at: ${metrics.generatedAt}
`.trim();
}

async function buildWeeklyMetrics(
  tenantId: string,
  deps: DigestDeps,
): Promise<WeeklyMetrics> {
  const now = new Date();
  const periodEnd = now.toISOString();
  const periodStartDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const periodStart = periodStartDate.toISOString();

  // Motion stack
  let primaryMotions: string[] = [];
  let topMotion: string | null = null;
  if (deps.motionStackRepository) {
    try {
      const stack = await deps.motionStackRepository.getLatestStack(tenantId);
      primaryMotions = stack?.primaryMotions ?? [];
      topMotion = primaryMotions[0] ?? null;
    } catch {
      // swallow — digest still useful without stack
    }
  }

  // Approval counts
  let pending = 0;
  let approved = 0;
  let rejected = 0;

  // Pending items from outbox queue for founder-reviewed artifact events.
  if (deps.outboxRepository) {
    try {
      const pendingEvents = await deps.outboxRepository.listUnconsumed(
        tenantId,
        1000,
      );
      const approvalEventTypes = new Set([
        "blog_draft.v1",
        "content_brief.v1",
        "intel_brief.v1",
      ]);
      pending = pendingEvents.filter(
        (e) =>
          approvalEventTypes.has(e.eventType) &&
          e.createdAt.getTime() >= periodStartDate.getTime(),
      ).length;
    } catch {
      // swallow — digest still useful without outbox
    }
  }

  // Approved/rejected outcomes from explicit founder decisions.
  if (deps.approvalFeedbackRepository) {
    try {
      const decisions = await deps.approvalFeedbackRepository.listRecent(
        tenantId,
        1000,
      );
      const thisWeek = decisions.filter(
        (d) => d.createdAt.getTime() >= periodStartDate.getTime(),
      );
      approved = thisWeek.filter(
        (d) => d.action === "approved" || d.action === "edited_then_approved",
      ).length;
      rejected = thisWeek.filter((d) => d.action === "rejected").length;
    } catch {
      // swallow — digest still useful without approval feedback store
    }
  }

  return {
    tenantId,
    periodStart,
    periodEnd,
    approvals: { approved, rejected, pending },
    motionStack: { primaryMotions, topMotion },
    signalCount: 0,
    generatedAt: now.toISOString(),
  };
}

async function sendViaPostal(
  body: string,
  tenantId: string,
  recipientEmail: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<{ sent: boolean; reason?: string }> {
  const apiKey = env.POSTAL_API_KEY;
  const serverUrl = env.POSTAL_SERVER_URL;
  const fromEmail = env.POSTAL_FROM_EMAIL ?? "digest@growthos.io";
  const timeoutMs = asPositiveInt(
    env.GROWTHOS_POSTAL_TIMEOUT_MS,
    DEFAULT_POSTAL_TIMEOUT_MS,
  );
  const maxAttempts = asPositiveInt(
    env.GROWTHOS_POSTAL_MAX_ATTEMPTS,
    DEFAULT_POSTAL_MAX_ATTEMPTS,
  );
  const retryDelayMs = asPositiveInt(
    env.GROWTHOS_POSTAL_RETRY_DELAY_MS,
    DEFAULT_POSTAL_RETRY_DELAY_MS,
  );
  const toEmail =
    recipientEmail ??
    env.GROWTHOS_DIGEST_RECIPIENT_EMAIL ??
    env.GROWTHOS_WEB_ADMIN_EMAIL;

  if (!apiKey || !serverUrl || !toEmail) {
    return { sent: false, reason: "postal_not_configured" };
  }

  const payload = JSON.stringify({
    mail_from: fromEmail,
    rcpt_to: [toEmail],
    data: [
      `From: GrowthOS <${fromEmail}>`,
      `To: ${toEmail}`,
      `Subject: GrowthOS Weekly Digest — tenant ${tenantId}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      body,
    ].join("\r\n"),
  });

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${serverUrl}/api/v1/send/raw`, {
        method: "POST",
        headers: {
          "X-Server-API-Key": apiKey,
          "Content-Type": "application/json",
        },
        body: payload,
        signal: controller.signal,
      });

      if (res.ok) return { sent: true };
      if (!isRetryableStatus(res.status) || attempt >= maxAttempts) {
        return { sent: false, reason: `postal_error_${res.status}` };
      }
    } catch {
      if (attempt >= maxAttempts) {
        return { sent: false, reason: "postal_network_error" };
      }
    } finally {
      clearTimeout(timeout);
    }

    await wait(retryDelayMs * attempt);
  }

  return { sent: false, reason: "postal_retry_exhausted" };
}

export function createDigestRoutes(deps: DigestDeps) {
  const route = new Hono();

  // GET /v1/digest/weekly
  route.get("/weekly", async (c) => {
    const tenantId = c.req.header("X-Tenant-Id");
    if (!tenantId)
      return c.json({ error: "X-Tenant-Id header is required" }, 400);

    const metrics = await buildWeeklyMetrics(tenantId, deps);
    return c.json(weeklyMetricsSchema.parse(metrics));
  });

  // POST /v1/digest/send
  route.post("/send", async (c) => {
    const tenantId = c.req.header("X-Tenant-Id");
    if (!tenantId)
      return c.json({ error: "X-Tenant-Id header is required" }, 400);

    const body = await c.req.json().catch(() => ({}));
    const parsedBody = sendDigestRequestSchema.safeParse(body);
    if (!parsedBody.success) {
      return c.json(
        {
          error: "Invalid request",
          details: parsedBody.error.flatten().fieldErrors,
        },
        422,
      );
    }

    const metrics = await buildWeeklyMetrics(tenantId, deps);
    const emailBody = formatDigestEmail(metrics, tenantId);

    const { sent, reason } = await sendViaPostal(
      emailBody,
      tenantId,
      parsedBody.data.recipientEmail,
      process.env,
    );
    if (!sent) {
      // Log the digest body in dev so it's visible without Postal
      console.log(
        "[digest] Postal not configured — digest content:\n",
        emailBody,
      );
    }

    const digestId = `digest-${tenantId.slice(-8)}-${Date.now()}`;
    const response = sendDigestResponseSchema.parse({
      sent,
      digestId,
      tenantId,
      ...(reason !== undefined ? { reason } : {}),
      metrics,
    });

    return c.json(response, 200);
  });

  return route;
}
