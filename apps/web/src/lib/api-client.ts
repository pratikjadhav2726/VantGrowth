/**
 * GrowthOS API client — typed wrappers for the @growthos/api Hono server.
 *
 * All methods:
 *   - Accept a `tenantId` parameter (sent as X-Tenant-Id header).
 *   - Throw `ApiError` on non-2xx responses.
 *   - Return typed response shapes validated by Zod at runtime.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const API_BASE =
  process.env.GROWTHOS_API_BASE_URL ??
  process.env.NEXT_PUBLIC_GROWTHOS_API_BASE_URL ??
  "http://localhost:3000";

// Server-side service token used to authenticate against the GrowthOS API's
// token-protected mutation routes (e.g. POST /v1/motions/score). Only available
// in server components / server actions — never exposed to the browser because
// it is intentionally NOT a NEXT_PUBLIC_ variable.
const SERVER_SERVICE_TOKEN = process.env.GROWTHOS_API_SERVICE_TOKEN;

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// ---------------------------------------------------------------------------
// Shared fetch helper
// ---------------------------------------------------------------------------

async function apiFetch<T>(
  path: string,
  tenantId: string,
  options: RequestInit & { schema: z.ZodType<T> },
): Promise<T> {
  const { schema, ...fetchOptions } = options;
  const res = await fetch(`${API_BASE}${path}`, {
    ...fetchOptions,
    headers: {
      "Content-Type": "application/json",
      "X-Tenant-Id": tenantId,
      // Authenticate token-protected mutation routes by default. An explicit
      // Authorization header (e.g. patchSettings) still overrides this.
      ...(SERVER_SERVICE_TOKEN
        ? { Authorization: `Bearer ${SERVER_SERVICE_TOKEN}` }
        : {}),
      ...(fetchOptions.headers as Record<string, string> | undefined),
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, `API request failed: ${res.status}`, body);
  }

  return schema.parse(await res.json());
}

// ---------------------------------------------------------------------------
// Approval queue types + client methods
// ---------------------------------------------------------------------------

export const approvalItemSchema = z.object({
  eventId: z.string(),
  tenantId: z.string(),
  outputType: z.string(),
  payload: z.record(z.unknown()),
  enqueuedAt: z.string(),
  status: z.literal("pending"),
});
export type ApprovalItem = z.infer<typeof approvalItemSchema>;

export const approvalListResponseSchema = z.object({
  items: z.array(approvalItemSchema),
  total: z.number(),
});

export const approvalDecisionResponseSchema = z.object({
  accepted: z.boolean(),
  feedbackId: z.string(),
  issueId: z.string(),
  action: z.string(),
  tenantId: z.string(),
  decidedAt: z.string(),
});
export type ApprovalDecisionResponse = z.infer<
  typeof approvalDecisionResponseSchema
>;

export const listApprovals = (
  tenantId: string,
  opts: { outputType?: string; limit?: number } = {},
) =>
  apiFetch(
    `/v1/approvals?outputType=${opts.outputType ?? "blog_draft.v1"}&limit=${opts.limit ?? 20}`,
    tenantId,
    { schema: approvalListResponseSchema },
  );

export const submitApprovalDecision = (
  tenantId: string,
  decision: {
    issueId: string;
    outputType: string;
    action: "approved" | "edited_then_approved" | "rejected";
    reviewerNote?: string;
    learnOptIn?: boolean;
  },
) =>
  apiFetch("/v1/approvals/decide", tenantId, {
    method: "POST",
    body: JSON.stringify(decision),
    schema: approvalDecisionResponseSchema,
  });

// ---------------------------------------------------------------------------
// Motion stack types + client methods
// ---------------------------------------------------------------------------

export const motionScoreRowSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  scoredAt: z.string(),
  scorerVersion: z.string(),
  scores: z.record(z.number()),
  inputsDigest: z.string(),
  rationale: z.array(z.string()),
  createdAt: z.string(),
});
export type MotionScoreRow = z.infer<typeof motionScoreRowSchema>;

export const motionStackRowSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  primaryMotions: z.array(z.string()),
  secondaryMotions: z.array(z.string()),
  observeOnly: z.array(z.string()),
  deactivated: z.array(z.string()),
  version: z.string(),
  createdAt: z.string(),
});
export type MotionStackRow = z.infer<typeof motionStackRowSchema>;

export const motionOverviewSchema = z.object({
  latestScore: motionScoreRowSchema.nullable(),
  latestStack: motionStackRowSchema.nullable(),
  recentScores: z.array(motionScoreRowSchema),
});
export type MotionOverview = z.infer<typeof motionOverviewSchema>;

export const getMotionOverview = (tenantId: string, historyLimit = 7) =>
  apiFetch(`/v1/motion?historyLimit=${historyLimit}`, tenantId, {
    schema: motionOverviewSchema,
  });

/** Fields for `POST /v1/motions/score` (tenantId passed separately for header + body). */
export const motionScoringFieldsSchema = z.object({
  productComplexity: z.number().min(0).max(1),
  trialability: z.number().min(0).max(1),
  acvBand: z.number().min(0).max(1),
  salesCycleWeeks: z.number().min(0),
  founderContentCapacity: z.number().min(0).max(1),
  categorySearchDemand: z.number().min(0).max(1),
  communityDensity: z.number().min(0).max(1),
  telemetryReadiness: z.number().min(0).max(1),
  budgetReadiness: z.number().min(0).max(1),
});
export type MotionScoringFields = z.infer<typeof motionScoringFieldsSchema>;

export const motionScoreResponseSchema = z.object({
  scoreId: z.string(),
  scorerVersion: z.string(),
  scores: z.record(z.number()),
  primaryMotions: z.array(z.string()),
  secondaryMotions: z.array(z.string()),
  rationale: z.array(z.string()),
  stackUpdated: z.boolean(),
});
export type MotionScoreResponse = z.infer<typeof motionScoreResponseSchema>;

export const postMotionScore = (
  tenantId: string,
  fields: MotionScoringFields,
) =>
  apiFetch("/v1/motions/score", tenantId, {
    method: "POST",
    body: JSON.stringify({ tenantId, ...fields }),
    schema: motionScoreResponseSchema,
  });

const signalGradeShape = z.object({
  relevance: z.number(),
  urgency: z.enum(["low", "medium", "high"]),
  topicCategory: z.string(),
  actionRecommendations: z.array(z.string()),
});

export const signalGradeApiResponseSchema = z.object({
  graded: z.boolean(),
  grade: signalGradeShape.nullable(),
});
export type SignalGradeApiResponse = z.infer<
  typeof signalGradeApiResponseSchema
>;

export const postSignalGrade = (
  tenantId: string,
  body: {
    signalType: string;
    source: string;
    payload?: Record<string, unknown>;
    motionContext?: string;
  },
) =>
  apiFetch("/v1/signals/grade", tenantId, {
    method: "POST",
    body: JSON.stringify(body),
    schema: signalGradeApiResponseSchema,
  });

// ---------------------------------------------------------------------------
// Signal ingestion
// ---------------------------------------------------------------------------

export const ingestSignalResponseSchema = z.object({
  accepted: z.boolean(),
  inserted: z.boolean(),
  signalId: z.string(),
  externalId: z.string().optional(),
  tenantId: z.string(),
});
export type IngestSignalResponse = z.infer<typeof ingestSignalResponseSchema>;

export const ingestSignal = (
  tenantId: string,
  signal: {
    signalType:
      | "competitive"
      | "community"
      | "icp"
      | "product"
      | "market"
      | "internal";
    source: string;
    externalId?: string;
    payload?: Record<string, unknown>;
  },
) =>
  apiFetch("/v1/signals", tenantId, {
    method: "POST",
    body: JSON.stringify(signal),
    schema: ingestSignalResponseSchema,
  });

// ---------------------------------------------------------------------------
// Founder digest
// ---------------------------------------------------------------------------

export const weeklyMetricsSchema = z.object({
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

export const sendDigestResponseSchema = z.object({
  sent: z.boolean(),
  digestId: z.string(),
  tenantId: z.string(),
  reason: z.string().optional(),
  metrics: weeklyMetricsSchema,
});
export type SendDigestResponse = z.infer<typeof sendDigestResponseSchema>;

export const getWeeklyDigest = (tenantId: string) =>
  apiFetch("/v1/digest/weekly", tenantId, { schema: weeklyMetricsSchema });

// ---------------------------------------------------------------------------
// Adaptive control plane
// ---------------------------------------------------------------------------

const controlPlaneDataSourceStatusSchema = z.enum([
  "available",
  "not_configured",
  "unavailable",
]);

const controlPlaneHealthStateSchema = z.enum([
  "healthy",
  "degraded",
  "recovering",
  "quarantined",
  "unknown",
]);

export const controlPlaneSummarySchema = z.object({
  tenantId: z.string(),
  generatedAt: z.string(),
  partial: z.boolean(),
  dataSources: z.object({
    signals: controlPlaneDataSourceStatusSchema,
    outbox: controlPlaneDataSourceStatusSchema,
    approvals: controlPlaneDataSourceStatusSchema,
    motion: controlPlaneDataSourceStatusSchema,
    componentHealth: controlPlaneDataSourceStatusSchema,
    incidents: controlPlaneDataSourceStatusSchema,
    experiments: controlPlaneDataSourceStatusSchema,
    learningProposals: controlPlaneDataSourceStatusSchema,
  }),
  signals: z.object({
    today: z.number().int().nonnegative(),
    windowStart: z.string(),
  }),
  approvals: z.object({
    pending: z.number().int().nonnegative(),
    pendingIsLowerBound: z.boolean(),
    decisionScanTruncated: z.boolean(),
    approvedLastSevenDays: z.number().int().nonnegative(),
    rejectedLastSevenDays: z.number().int().nonnegative(),
  }),
  execution: z.object({
    pendingOutboxEvents: z.number().int().nonnegative(),
    pendingOutboxEventsIsLowerBound: z.boolean(),
  }),
  motion: z.object({
    primaryMotions: z.array(z.string()),
    secondaryMotions: z.array(z.string()),
    scorerVersion: z.string().nullable(),
    scoredAt: z.string().nullable(),
  }),
  health: z.object({
    overall: controlPlaneHealthStateSchema,
    overallMayBeIncomplete: z.boolean(),
    components: z.number().int().nonnegative(),
    componentsIsLowerBound: z.boolean(),
    degraded: z.number().int().nonnegative(),
    recovering: z.number().int().nonnegative(),
    quarantined: z.number().int().nonnegative(),
    externalActionsBlocked: z.number().int().nonnegative(),
  }),
  incidents: z.object({
    open: z.number().int().nonnegative(),
    openIsLowerBound: z.boolean(),
    criticalOpen: z.number().int().nonnegative(),
    criticalOpenIsLowerBound: z.boolean(),
  }),
  experiments: z.object({
    total: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    paused: z.number().int().nonnegative(),
    concluded: z.number().int().nonnegative(),
    promoted: z.number().int().nonnegative(),
    rolledBack: z.number().int().nonnegative(),
  }),
  learning: z.object({
    total: z.number().int().nonnegative(),
    awaitingEvidence: z.number().int().nonnegative(),
    evaluating: z.number().int().nonnegative(),
    requiresApproval: z.number().int().nonnegative(),
    promoted: z.number().int().nonnegative(),
    rolledBack: z.number().int().nonnegative(),
  }),
});
export type ControlPlaneSummary = z.infer<typeof controlPlaneSummarySchema>;

export const componentHealthItemSchema = z.object({
  componentId: z.string(),
  state: controlPlaneHealthStateSchema.exclude(["unknown"]),
  action: z.string(),
  allowExternalActions: z.boolean(),
  reasons: z.array(z.string()),
  observedAt: z.string(),
});
export type ComponentHealthItem = z.infer<typeof componentHealthItemSchema>;

export const controlPlaneHealthResponseSchema = z.object({
  tenantId: z.string(),
  generatedAt: z.string(),
  overall: controlPlaneHealthStateSchema,
  items: z.array(componentHealthItemSchema),
  total: z.number().int().nonnegative(),
  totalIsLowerBound: z.boolean(),
});
export type ControlPlaneHealthResponse = z.infer<
  typeof controlPlaneHealthResponseSchema
>;

export const incidentItemSchema = z.object({
  id: z.string(),
  componentId: z.string(),
  severity: z.enum(["low", "medium", "high", "critical"]),
  status: z.string(),
  title: z.string(),
  summary: z.string(),
  openedAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export type IncidentItem = z.infer<typeof incidentItemSchema>;

export const controlPlaneIncidentResponseSchema = z.object({
  tenantId: z.string(),
  generatedAt: z.string(),
  items: z.array(incidentItemSchema),
  total: z.number().int().nonnegative(),
  totalIsLowerBound: z.boolean(),
  open: z.number().int().nonnegative(),
});
export type ControlPlaneIncidentResponse = z.infer<
  typeof controlPlaneIncidentResponseSchema
>;

export const getControlPlaneSummary = (tenantId: string) =>
  apiFetch("/v1/control-plane/summary", tenantId, {
    cache: "no-store",
    schema: controlPlaneSummarySchema,
  });

export const getControlPlaneHealth = (tenantId: string, limit = 100) =>
  apiFetch(`/v1/control-plane/health?limit=${limit}`, tenantId, {
    cache: "no-store",
    schema: controlPlaneHealthResponseSchema,
  });

export const listControlPlaneIncidents = (tenantId: string, limit = 50) =>
  apiFetch(`/v1/control-plane/incidents?limit=${limit}`, tenantId, {
    cache: "no-store",
    schema: controlPlaneIncidentResponseSchema,
  });

// ---------------------------------------------------------------------------
// Tenant settings
// ---------------------------------------------------------------------------

const settingsResponseSchema = z.object({
  tenantId: z.string(),
  settings: z.record(z.unknown()),
});

export const getSettings = (tenantId: string) =>
  apiFetch("/v1/settings", tenantId, { schema: settingsResponseSchema });

export const patchSettings = (
  tenantId: string,
  patch: Record<string, unknown>,
  serviceToken: string,
) =>
  apiFetch("/v1/settings", tenantId, {
    method: "PATCH",
    body: JSON.stringify(patch),
    headers: { Authorization: `Bearer ${serviceToken}` },
    schema: settingsResponseSchema,
  });

export const sendFounderDigest = (
  tenantId: string,
  options?: { recipientEmail?: string },
) =>
  apiFetch("/v1/digest/send", tenantId, {
    method: "POST",
    body: JSON.stringify({
      ...(options?.recipientEmail
        ? { recipientEmail: options.recipientEmail }
        : {}),
    }),
    schema: sendDigestResponseSchema,
  });
