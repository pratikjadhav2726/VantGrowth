/**
 * Provisions a well-known development tenant across all GrowthOS Postgres
 * tables and optionally publishes a seed event to NATS JetStream.
 *
 * Idempotent: safe to run multiple times.  A seed-sentinel row in
 * `event_outbox` guards against duplicate insertions.
 *
 * Required env:
 *   DATABASE_URL  — Postgres connection string
 *
 * Optional env:
 *   GROWTHOS_DEV_TENANT_ID  — override the well-known dev UUID
 *   NATS_SERVERS            — e.g. nats://127.0.0.1:4228
 *
 * Usage (repo root):
 *   pnpm infra:up
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5488/growthos_ci pnpm migrate:dry-run
 *   DATABASE_URL=... [NATS_SERVERS=...] pnpm seed:dev
 */
import { and, eq, isNull } from "drizzle-orm";
import { StringCodec, connect } from "nats";
import { createDbFromEnv } from "./db.js";
import {
  approvalFeedback,
  eventOutbox,
  motionScores,
  motionStack,
  playbookVersions,
  workflowRuns,
} from "./schema.js";

const DEV_TENANT_ID =
  process.env.GROWTHOS_DEV_TENANT_ID ?? "00000000-0000-0000-0001-000000000001";

const SEED_IDEMPOTENCY_KEY = "seed-dev-v1";
const SEED_EVENT_TYPE = "growthos.seed_dev.v1";

// ── helpers ───────────────────────────────────────────────────────────────────

function ok(msg: string): void {
  console.log(`  ✓ ${msg}`);
}

function skip(msg: string): void {
  console.log(`  · ${msg} (already present)`);
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const start = Date.now();

  const db = createDbFromEnv();
  console.log("\nseed-dev: provisioning dev tenant");
  console.log(`  tenant_id : ${DEV_TENANT_ID}`);
  console.log(
    `  database  : ${process.env.DATABASE_URL?.replace(/:[^@]*@/, ":***@")}`,
  );
  console.log();

  // ── idempotency guard ──────────────────────────────────────────────────────
  // If the sentinel outbox row already exists, the tenant is already seeded.
  const [existing] = await db
    .select({ id: eventOutbox.id })
    .from(eventOutbox)
    .where(eq(eventOutbox.idempotencyKey, SEED_IDEMPOTENCY_KEY))
    .limit(1);

  if (existing) {
    skip("event_outbox sentinel — tenant already seeded, skipping all inserts");
    console.log();
    console.log(
      `seed-dev: tenant ${DEV_TENANT_ID} was already seeded.  Use a different GROWTHOS_DEV_TENANT_ID to re-seed.`,
    );
    return;
  }

  // ── motion_scores ──────────────────────────────────────────────────────────
  const [scoreRow] = await db
    .insert(motionScores)
    .values({
      tenantId: DEV_TENANT_ID,
      scorerVersion: "v1.0.0-seed",
      scores: {
        "product-led-growth": 0.85,
        "outbound-sales": 0.62,
        "content-marketing": 0.71,
      },
      inputsDigest: "seed-dev-digest-v1",
      rationale: [
        "Strong product-led growth signals from trial-to-paid data.",
        "Moderate outbound traction — low response rates, high reply quality.",
        "Early content marketing signals positive.",
      ],
    })
    .returning({ id: motionScores.id });

  ok(`growthos.motion_scores  (id: ${scoreRow?.id ?? "—"})`);

  // ── motion_stack ───────────────────────────────────────────────────────────
  await db
    .insert(motionStack)
    .values({
      tenantId: DEV_TENANT_ID,
      primaryMotions: ["product-led-growth"],
      secondaryMotions: ["content-marketing"],
      observeOnly: ["outbound-sales"],
      deactivated: [],
      sourceScoreId: scoreRow?.id ?? null,
      version: "1",
    })
    .onConflictDoNothing();

  ok("growthos.motion_stack   (v1, PLG primary)");

  // ── approval_feedback ──────────────────────────────────────────────────────
  // approval_feedback has no unique constraint — insert only if none yet.
  const [existingFeedback] = await db
    .select({ id: approvalFeedback.id })
    .from(approvalFeedback)
    .where(eq(approvalFeedback.tenantId, DEV_TENANT_ID))
    .limit(1);

  if (!existingFeedback) {
    await db.insert(approvalFeedback).values({
      tenantId: DEV_TENANT_ID,
      issueId: "00000000-0000-0000-0002-000000000001",
      outputType: "content_brief",
      action: "auto_approved",
      learnOptIn: true,
    });
    ok("growthos.approval_feedback (content_brief, auto_approved)");
  } else {
    skip("growthos.approval_feedback");
  }

  // ── workflow_runs ──────────────────────────────────────────────────────────
  await db
    .insert(workflowRuns)
    .values({
      tenantId: DEV_TENANT_ID,
      workflowId: `seed-dev-${DEV_TENANT_ID}`,
      dedupeKey: SEED_IDEMPOTENCY_KEY,
      state: "completed",
    })
    .onConflictDoNothing();

  ok("growthos.workflow_runs  (seed-dev, completed)");

  // ── playbook_versions ─────────────────────────────────────────────────────
  // Seed a blog_draft rubric and a content_brief rubric for the dev tenant.
  // These are used by the CritiqueWorker (playbook path) and the LearningWorker
  // (feedback loop) during local development.

  const blogDraftExists = await db
    .select({ id: playbookVersions.id })
    .from(playbookVersions)
    .where(
      and(
        eq(playbookVersions.tenantId, DEV_TENANT_ID),
        eq(playbookVersions.playbookType, "blog_draft"),
        isNull(playbookVersions.retiredAt),
      ),
    )
    .limit(1);

  if (blogDraftExists.length === 0) {
    await db.insert(playbookVersions).values({
      tenantId: DEV_TENANT_ID,
      playbookType: "blog_draft",
      version: "1",
      name: "Blog Draft Quality Rubric v1",
      description:
        "Standard rubric for evaluating blog draft quality. " +
        "Checks for CTA, evidence, structure, readability, and brand voice.",
      content: {
        rubric: [
          {
            id: "bd-r1",
            weight: 0.25,
            description: "Content includes a clear call to action",
            check: "has_cta",
          },
          {
            id: "bd-r2",
            weight: 0.2,
            description: "Content includes quantitative evidence or statistics",
            check: "has_evidence",
          },
          {
            id: "bd-r3",
            weight: 0.2,
            description: "No forbidden corporate buzzwords",
            check: "no_forbidden",
          },
          {
            id: "bd-r4",
            weight: 0.2,
            description: "Word count within acceptable range (300–3000 words)",
            check: "length_ok",
          },
          {
            id: "bd-r5",
            weight: 0.15,
            description: "Article uses markdown headings for clear structure",
            check: "has_headings",
          },
        ],
        min_word_count: 300,
        max_word_count: 3000,
        forbidden_phrases: [
          "market leader",
          "industry-leading",
          "best-in-class",
          "world-class",
          "revolutionary",
          "cutting-edge",
          "synergy",
        ],
      },
      createdBy: "seed-dev",
    });
    ok("growthos.playbook_versions (blog_draft v1)");
  } else {
    skip("growthos.playbook_versions (blog_draft v1)");
  }

  const contentBriefExists = await db
    .select({ id: playbookVersions.id })
    .from(playbookVersions)
    .where(
      and(
        eq(playbookVersions.tenantId, DEV_TENANT_ID),
        eq(playbookVersions.playbookType, "content_brief"),
        isNull(playbookVersions.retiredAt),
      ),
    )
    .limit(1);

  if (contentBriefExists.length === 0) {
    await db.insert(playbookVersions).values({
      tenantId: DEV_TENANT_ID,
      playbookType: "content_brief",
      version: "1",
      name: "Content Brief Quality Rubric v1",
      description:
        "Standard rubric for evaluating content brief quality. " +
        "Ensures the brief is actionable, evidence-backed, and audience-targeted.",
      content: {
        rubric: [
          {
            id: "cb-r1",
            weight: 0.3,
            description: "Brief specifies a clear hook for the opening",
            check: "has_hook",
          },
          {
            id: "cb-r2",
            weight: 0.25,
            description: "Brief identifies a specific target audience",
            check: "has_evidence",
          },
          {
            id: "cb-r3",
            weight: 0.25,
            description:
              "Brief includes a call to action for the finished piece",
            check: "has_cta",
          },
          {
            id: "cb-r4",
            weight: 0.2,
            description: "Brief has sufficient detail (min 150 words)",
            check: "length_ok",
          },
        ],
        min_word_count: 150,
        max_word_count: 1000,
      },
      createdBy: "seed-dev",
    });
    ok("growthos.playbook_versions (content_brief v1)");
  } else {
    skip("growthos.playbook_versions (content_brief v1)");
  }

  // ── event_outbox sentinel ─────────────────────────────────────────────────
  await db.insert(eventOutbox).values({
    tenantId: DEV_TENANT_ID,
    eventType: SEED_EVENT_TYPE,
    idempotencyKey: SEED_IDEMPOTENCY_KEY,
    payload: {
      tenant_id: DEV_TENANT_ID,
      seed_version: "v1",
      seeded_at: new Date().toISOString(),
    },
  });

  ok("growthos.event_outbox   (sentinel: seed-dev-v1)");

  // ── optional NATS publish ─────────────────────────────────────────────────
  const natsServers = process.env.NATS_SERVERS?.trim();
  if (natsServers) {
    const subject = `t.${DEV_TENANT_ID}.${SEED_EVENT_TYPE}`;
    try {
      const nc = await connect({ servers: natsServers });
      const sc = StringCodec();
      nc.publish(
        subject,
        sc.encode(
          JSON.stringify({
            tenant_id: DEV_TENANT_ID,
            seed_version: "v1",
            seeded_at: new Date().toISOString(),
          }),
        ),
      );
      await nc.flush();
      await nc.drain();
      ok(`NATS JetStream published → ${subject}`);
    } catch (err: unknown) {
      console.warn(
        `  ⚠ NATS publish skipped — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  console.log();
  console.log(`seed-dev: ✓ done in ${Date.now() - start}ms`);
  console.log(
    "  Run `pnpm smoke:infra` with DATABASE_URL + NATS_SERVERS to verify end-to-end.",
  );
  console.log();
}

main().catch((err: unknown) => {
  console.error(
    "\nseed-dev: ✗",
    err instanceof Error ? err.message : String(err),
  );
  process.exitCode = 1;
});
