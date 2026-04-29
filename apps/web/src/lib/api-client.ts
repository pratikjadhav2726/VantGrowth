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
