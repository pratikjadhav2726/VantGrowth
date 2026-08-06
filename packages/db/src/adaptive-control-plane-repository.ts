/**
 * Durable adaptive-GTM control plane repositories.
 *
 * The persistence layer deliberately separates mutable lifecycle state from
 * immutable evidence. Experiments and proposals move through guarded state
 * machines; assignments, observations, and health decisions are append-only.
 * Every Postgres operation runs inside a transaction with the tenant RLS
 * context set locally before it touches a tenant-scoped table.
 */

import {
  and,
  avg,
  count,
  desc,
  eq,
  gt,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import {
  type EnqueueOutboxEvent,
  type StoredOutboxEvent,
  storedOutboxEventSchema,
  tenantIdSchema,
} from "./contracts.js";
import type { GrowthOsDb } from "./db.js";
import {
  InMemoryOutboxRepository,
  type OutboxRepository,
} from "./outbox-repository.js";
import {
  type ComponentHealth,
  type Experiment,
  type ExperimentAssignment,
  type ExperimentObservation,
  type Incident,
  type LearningProposal,
  componentHealth,
  eventOutbox,
  experimentAssignments,
  experimentObservations,
  experimentStatusValues,
  experimentVariantValues,
  experimentWinnerValues,
  experiments,
  healingActionValues,
  incidentSeverityValues,
  incidentStatusValues,
  incidents,
  learningDecisionValues,
  learningProposalStatusValues,
  learningProposals,
  metricDirectionValues,
  runtimeHealthStateValues,
} from "./schema.js";
import type { TenantContext } from "./tenant-context.js";

type TxClient = Parameters<Parameters<GrowthOsDb["transaction"]>[0]>[0];

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 250;
const limitSchema = z.number().int().positive().max(MAX_LIMIT);
const recordSchema = z.record(z.unknown());
const nonEmptyText = z.string().trim().min(1);
const isoCurrencySchema = z
  .string()
  .trim()
  .length(3)
  .transform((value) => value.toUpperCase());

const normalizeLimit = (limit: number | undefined): number =>
  limitSchema.parse(limit ?? DEFAULT_LIMIT);

const setTenantContext = (
  tx: TxClient,
  tenantId: string,
  context: Partial<TenantContext> = {},
) =>
  tx.execute(
    sql`SELECT
      set_config('app.tenant_id',  ${tenantId},                         true),
      set_config('app.actor_id',   ${context.actorId ?? ""},           true),
      set_config('app.actor_kind', ${context.actorKind ?? "system"},   true)`,
  );

const withTenantContext = async <T>(
  db: GrowthOsDb,
  tenantId: string,
  context: Partial<TenantContext>,
  fn: (tx: TxClient) => Promise<T>,
): Promise<T> => {
  const parsedTenantId = tenantIdSchema.parse(tenantId);
  return db.transaction(async (tx) => {
    await setTenantContext(tx, parsedTenantId, context);
    return fn(tx);
  });
};

// ─── Experiment records and lifecycle ─────────────────────────────────────

export const experimentStatusSchema = z.enum(experimentStatusValues);
export type ExperimentStatus = z.infer<typeof experimentStatusSchema>;

export const experimentVariantSchema = z.enum(experimentVariantValues);
export type ExperimentVariant = z.infer<typeof experimentVariantSchema>;

export const experimentWinnerSchema = z.enum(experimentWinnerValues);
export type ExperimentWinner = z.infer<typeof experimentWinnerSchema>;

export const metricDirectionSchema = z.enum(metricDirectionValues);
export type MetricDirection = z.infer<typeof metricDirectionSchema>;

export const experimentRecordSchema = z.object({
  id: z.string().uuid(),
  tenantId: tenantIdSchema,
  experimentKey: nonEmptyText,
  motion: nonEmptyText,
  experimentType: nonEmptyText,
  unitType: nonEmptyText,
  hypothesis: nonEmptyText,
  variantA: recordSchema,
  variantB: recordSchema,
  metricName: nonEmptyText,
  metricDirection: metricDirectionSchema,
  minSampleSize: z.number().int().positive(),
  status: experimentStatusSchema,
  winner: experimentWinnerSchema.nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  inputSnapshot: recordSchema,
  modelVersion: z.string().nullable(),
  promptVersion: z.string().nullable(),
  playbookVersion: z.string().nullable(),
  policyVersion: z.string().nullable(),
  createdBy: nonEmptyText,
  startedAt: z.date().nullable(),
  endedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type ExperimentRecord = z.infer<typeof experimentRecordSchema>;

export const createExperimentParamsSchema = z.object({
  experimentKey: nonEmptyText,
  motion: nonEmptyText,
  experimentType: nonEmptyText,
  unitType: nonEmptyText,
  hypothesis: nonEmptyText,
  variantA: recordSchema,
  variantB: recordSchema,
  metricName: nonEmptyText,
  metricDirection: metricDirectionSchema.default("increase"),
  minSampleSize: z.number().int().positive(),
  initialStatus: z.enum(["draft", "running"]).default("draft"),
  inputSnapshot: recordSchema.default({}),
  modelVersion: z.string().trim().min(1).optional(),
  promptVersion: z.string().trim().min(1).optional(),
  playbookVersion: z.string().trim().min(1).optional(),
  policyVersion: z.string().trim().min(1).optional(),
  createdBy: nonEmptyText,
  startedAt: z.date().optional(),
});
export type CreateExperimentParams = z.input<
  typeof createExperimentParamsSchema
>;

export const transitionExperimentParamsSchema = z.object({
  winner: experimentWinnerSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  endedAt: z.date().optional(),
});
export type TransitionExperimentParams = z.input<
  typeof transitionExperimentParamsSchema
>;

const experimentTransitions: Readonly<
  Record<ExperimentStatus, readonly ExperimentStatus[]>
> = {
  draft: ["running", "abandoned"],
  running: ["paused", "concluded", "abandoned"],
  paused: ["running", "abandoned"],
  concluded: ["promoted", "abandoned"],
  abandoned: [],
  promoted: ["rolled_back"],
  rolled_back: [],
};

const assertExperimentTransition = (
  from: ExperimentStatus,
  to: ExperimentStatus,
): void => {
  if (!experimentTransitions[from].includes(to)) {
    throw new Error(`Illegal experiment transition: ${from} -> ${to}`);
  }
};

const mapExperiment = (row: Experiment): ExperimentRecord =>
  experimentRecordSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    experimentKey: row.experimentKey,
    motion: row.motion,
    experimentType: row.experimentType,
    unitType: row.unitType,
    hypothesis: row.hypothesis,
    variantA: row.variantA,
    variantB: row.variantB,
    metricName: row.metricName,
    metricDirection: row.metricDirection,
    minSampleSize: row.minSampleSize,
    status: row.status,
    winner: row.winner ?? null,
    confidence: row.confidence === null ? null : Number(row.confidence),
    inputSnapshot: row.inputSnapshot,
    modelVersion: row.modelVersion ?? null,
    promptVersion: row.promptVersion ?? null,
    playbookVersion: row.playbookVersion ?? null,
    policyVersion: row.policyVersion ?? null,
    createdBy: row.createdBy,
    startedAt: row.startedAt ?? null,
    endedAt: row.endedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

export const experimentAssignmentRecordSchema = z.object({
  id: z.string().uuid(),
  tenantId: tenantIdSchema,
  experimentId: z.string().uuid(),
  entityType: nonEmptyText,
  entityId: nonEmptyText,
  variant: experimentVariantSchema,
  assignmentContext: recordSchema,
  assignedAt: z.date(),
  exposedAt: z.date().nullable(),
  createdAt: z.date(),
});
export type ExperimentAssignmentRecord = z.infer<
  typeof experimentAssignmentRecordSchema
>;

export const assignExperimentParamsSchema = z.object({
  experimentId: z.string().uuid(),
  entityType: nonEmptyText,
  entityId: nonEmptyText,
  variant: experimentVariantSchema,
  assignmentContext: recordSchema.default({}),
  exposedAt: z.date().optional(),
});
export type AssignExperimentParams = z.input<
  typeof assignExperimentParamsSchema
>;

export interface AssignExperimentResult {
  assignment: ExperimentAssignmentRecord;
  isExisting: boolean;
}

const mapAssignment = (row: ExperimentAssignment): ExperimentAssignmentRecord =>
  experimentAssignmentRecordSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    experimentId: row.experimentId,
    entityType: row.entityType,
    entityId: row.entityId,
    variant: row.variant,
    assignmentContext: row.assignmentContext,
    assignedAt: row.assignedAt,
    exposedAt: row.exposedAt ?? null,
    createdAt: row.createdAt,
  });

export const experimentObservationRecordSchema = z.object({
  id: z.string().uuid(),
  tenantId: tenantIdSchema,
  experimentId: z.string().uuid(),
  assignmentId: z.string().uuid().nullable(),
  idempotencyKey: nonEmptyText,
  entityType: nonEmptyText,
  entityId: nonEmptyText,
  variant: experimentVariantSchema,
  metricName: nonEmptyText,
  metricValue: z.number().finite(),
  isGuardrail: z.boolean(),
  attributionConfidence: z.number().min(0).max(1),
  attributionModel: nonEmptyText,
  source: nonEmptyText,
  costAmount: z.number().nonnegative().nullable(),
  costCurrency: z.string().length(3).nullable(),
  observedOutcome: recordSchema,
  evidence: recordSchema,
  observedAt: z.date(),
  createdAt: z.date(),
});
export type ExperimentObservationRecord = z.infer<
  typeof experimentObservationRecordSchema
>;

export const recordExperimentObservationParamsSchema = z.object({
  experimentId: z.string().uuid(),
  assignmentId: z.string().uuid().optional(),
  idempotencyKey: nonEmptyText,
  entityType: nonEmptyText,
  entityId: nonEmptyText,
  variant: experimentVariantSchema,
  metricName: nonEmptyText,
  metricValue: z.number().finite(),
  isGuardrail: z.boolean().default(false),
  attributionConfidence: z.number().min(0).max(1),
  attributionModel: nonEmptyText,
  source: nonEmptyText,
  costAmount: z.number().nonnegative().optional(),
  costCurrency: isoCurrencySchema.optional(),
  observedOutcome: recordSchema.default({}),
  evidence: recordSchema.default({}),
  observedAt: z.date().optional(),
});
export type RecordExperimentObservationParams = z.input<
  typeof recordExperimentObservationParamsSchema
>;

const mapObservation = (
  row: ExperimentObservation,
): ExperimentObservationRecord =>
  experimentObservationRecordSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    experimentId: row.experimentId,
    assignmentId: row.assignmentId ?? null,
    idempotencyKey: row.idempotencyKey,
    entityType: row.entityType,
    entityId: row.entityId,
    variant: row.variant,
    metricName: row.metricName,
    metricValue: Number(row.metricValue),
    isGuardrail: row.isGuardrail,
    attributionConfidence: Number(row.attributionConfidence),
    attributionModel: row.attributionModel,
    source: row.source,
    costAmount: row.costAmount === null ? null : Number(row.costAmount),
    costCurrency: row.costCurrency ?? null,
    observedOutcome: row.observedOutcome,
    evidence: row.evidence,
    observedAt: row.observedAt,
    createdAt: row.createdAt,
  });

export interface ExperimentEvidenceSummary {
  experimentId: string;
  metricName: string;
  evidenceCount: number;
  uniqueEntities: number;
  baselineMetric: number;
  candidateMetric: number;
  /** Mean attribution confidence, not a causal confidence claim. */
  meanAttributionConfidence: number;
  baselineGuardrailMetric: number | null;
  candidateGuardrailMetric: number | null;
  /** Positive values mean a guardrail worsened for variant B. */
  worstGuardrailRegression: number;
}

export interface ExperimentStatusSummary {
  total: number;
  byStatus: Record<ExperimentStatus, number>;
}

export interface ExperimentRepository {
  create(
    tenantId: string,
    params: CreateExperimentParams,
  ): Promise<ExperimentRecord>;
  getById(tenantId: string, id: string): Promise<ExperimentRecord | null>;
  listRecent(tenantId: string, limit?: number): Promise<ExperimentRecord[]>;
  getSummary(tenantId: string): Promise<ExperimentStatusSummary>;
  transition(
    tenantId: string,
    id: string,
    fromStatus: ExperimentStatus,
    toStatus: ExperimentStatus,
    params?: TransitionExperimentParams,
  ): Promise<ExperimentRecord | null>;
  assign(
    tenantId: string,
    params: AssignExperimentParams,
  ): Promise<AssignExperimentResult>;
  recordObservation(
    tenantId: string,
    params: RecordExperimentObservationParams,
  ): Promise<ExperimentObservationRecord>;
  /** Semantic alias for outcome-capture workers. */
  recordOutcome(
    tenantId: string,
    params: RecordExperimentObservationParams,
  ): Promise<ExperimentObservationRecord>;
  listObservations(
    tenantId: string,
    experimentId: string,
    options?: { metricName?: string; limit?: number },
  ): Promise<ExperimentObservationRecord[]>;
  summarizeEvidence(
    tenantId: string,
    experimentId: string,
    metricName: string,
    guardrailMetricName?: string,
  ): Promise<ExperimentEvidenceSummary | null>;
}

const emptyExperimentStatusSummary = (): ExperimentStatusSummary => ({
  total: 0,
  byStatus: {
    draft: 0,
    running: 0,
    paused: 0,
    concluded: 0,
    abandoned: 0,
    promoted: 0,
    rolled_back: 0,
  },
});

// ─── Learning proposals ────────────────────────────────────────────────────

export const changeRiskSchema = z.enum(["low", "medium", "high", "critical"]);
export type ChangeRisk = z.infer<typeof changeRiskSchema>;

export const learningDecisionSchema = z.enum(learningDecisionValues);
export type LearningDecision = z.infer<typeof learningDecisionSchema>;

export const learningProposalStatusSchema = z.enum(
  learningProposalStatusValues,
);
export type LearningProposalStatus = z.infer<
  typeof learningProposalStatusSchema
>;

export const learningProposalRecordSchema = z.object({
  id: z.string().uuid(),
  tenantId: tenantIdSchema,
  proposalKey: nonEmptyText,
  experimentId: z.string().uuid().nullable(),
  targetType: nonEmptyText,
  targetId: nonEmptyText,
  risk: changeRiskSchema,
  status: learningProposalStatusSchema,
  proposalPayload: recordSchema,
  evidenceSnapshot: recordSchema,
  evaluationSnapshot: recordSchema,
  decision: learningDecisionSchema.nullable(),
  decisionReasons: z.array(nonEmptyText),
  baseVersionRef: z.string().nullable(),
  candidateVersionRef: z.string().nullable(),
  promotedVersionRef: z.string().nullable(),
  rollbackVersionRef: z.string().nullable(),
  humanApprovedBy: z.string().nullable(),
  humanApprovedAt: z.date().nullable(),
  /** Internal fencing token; never expose this through founder APIs. */
  promotionClaimToken: z.string().uuid().nullable(),
  promotionClaimExpiresAt: z.date().nullable(),
  createdBy: nonEmptyText,
  evaluatedAt: z.date().nullable(),
  promotedAt: z.date().nullable(),
  rolledBackAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type LearningProposalRecord = z.infer<
  typeof learningProposalRecordSchema
>;

export const createLearningProposalParamsSchema = z.object({
  proposalKey: nonEmptyText,
  experimentId: z.string().uuid().optional(),
  targetType: nonEmptyText,
  targetId: nonEmptyText,
  risk: changeRiskSchema,
  proposalPayload: recordSchema,
  baseVersionRef: z.string().trim().min(1).optional(),
  candidateVersionRef: z.string().trim().min(1).optional(),
  createdBy: nonEmptyText,
});
export type CreateLearningProposalParams = z.input<
  typeof createLearningProposalParamsSchema
>;

export const recordLearningProposalEvaluationParamsSchema = z.object({
  decision: learningDecisionSchema,
  evidenceSnapshot: recordSchema,
  evaluationSnapshot: recordSchema,
  decisionReasons: z.array(nonEmptyText).min(1),
});
export type RecordLearningProposalEvaluationParams = z.input<
  typeof recordLearningProposalEvaluationParamsSchema
>;

const mapLearningProposal = (row: LearningProposal): LearningProposalRecord =>
  learningProposalRecordSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    proposalKey: row.proposalKey,
    experimentId: row.experimentId ?? null,
    targetType: row.targetType,
    targetId: row.targetId,
    risk: row.risk,
    status: row.status,
    proposalPayload: row.proposalPayload,
    evidenceSnapshot: row.evidenceSnapshot,
    evaluationSnapshot: row.evaluationSnapshot,
    decision: row.decision ?? null,
    decisionReasons: row.decisionReasons,
    baseVersionRef: row.baseVersionRef ?? null,
    candidateVersionRef: row.candidateVersionRef ?? null,
    promotedVersionRef: row.promotedVersionRef ?? null,
    rollbackVersionRef: row.rollbackVersionRef ?? null,
    humanApprovedBy: row.humanApprovedBy ?? null,
    humanApprovedAt: row.humanApprovedAt ?? null,
    promotionClaimToken: row.promotionClaimToken ?? null,
    promotionClaimExpiresAt: row.promotionClaimExpiresAt ?? null,
    createdBy: row.createdBy,
    evaluatedAt: row.evaluatedAt ?? null,
    promotedAt: row.promotedAt ?? null,
    rolledBackAt: row.rolledBackAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

export interface LearningProposalStatusSummary {
  total: number;
  byStatus: Record<LearningProposalStatus, number>;
}

/**
 * A founder approval is not complete until the learning worker has a durable
 * request to re-evaluate it. The event uses the proposal UUID because the
 * worker intentionally re-reads the proposal and its latest evidence rather
 * than trusting an event snapshot for promotion.
 */
export const learningProposalApprovedEventType =
  "learning.proposal.approved.v1" as const;

export interface ApproveLearningProposalResult {
  proposal: LearningProposalRecord;
  outboxEvent: StoredOutboxEvent;
}

const MIN_PROMOTION_CLAIM_LEASE_MS = 1_000;
const MAX_PROMOTION_CLAIM_LEASE_MS = 15 * 60_000;
const DEFAULT_PROMOTION_CLAIM_LEASE_MS = 60_000;

export const promotionClaimOptionsSchema = z.object({
  leaseMs: z
    .number()
    .int()
    .min(MIN_PROMOTION_CLAIM_LEASE_MS)
    .max(MAX_PROMOTION_CLAIM_LEASE_MS)
    .default(DEFAULT_PROMOTION_CLAIM_LEASE_MS),
  /** Deterministic clock seam for repository tests; production omits it. */
  now: z.date().optional(),
});
export type PromotionClaimOptions = z.input<typeof promotionClaimOptionsSchema>;

export interface PromotionClaim {
  proposal: LearningProposalRecord;
  token: string;
  expiresAt: Date;
}

const hasActivePromotionClaim = (
  proposal: Pick<
    LearningProposalRecord,
    "promotionClaimToken" | "promotionClaimExpiresAt"
  >,
  now: Date,
): boolean =>
  proposal.promotionClaimToken !== null &&
  proposal.promotionClaimExpiresAt !== null &&
  proposal.promotionClaimExpiresAt.getTime() > now.getTime();

const learningProposalApprovalOutboxCommand = (
  proposal: LearningProposalRecord,
): EnqueueOutboxEvent => ({
  tenantId: proposal.tenantId,
  eventType: learningProposalApprovedEventType,
  idempotencyKey: `learning-proposal-approved:${proposal.id}`,
  payload: {
    proposal_id: proposal.id,
    proposal_key: proposal.proposalKey,
    approved_by: proposal.humanApprovedBy ?? "",
    approved_at: proposal.humanApprovedAt?.toISOString() ?? null,
  },
});

const mapStoredOutboxEvent = (
  row: typeof eventOutbox.$inferSelect,
): StoredOutboxEvent =>
  storedOutboxEventSchema.parse({
    id: String(row.id),
    tenantId: row.tenantId,
    eventType: row.eventType,
    idempotencyKey: row.idempotencyKey,
    payload: row.payload,
    createdAt: row.createdAt,
    consumedAt: row.consumedAt ?? null,
  });

export interface LearningProposalRepository {
  create(
    tenantId: string,
    params: CreateLearningProposalParams,
  ): Promise<LearningProposalRecord>;
  getById(tenantId: string, id: string): Promise<LearningProposalRecord | null>;
  getByProposalKey(
    tenantId: string,
    proposalKey: string,
  ): Promise<LearningProposalRecord | null>;
  listRecent(
    tenantId: string,
    limit?: number,
    status?: LearningProposalStatus,
  ): Promise<LearningProposalRecord[]>;
  getSummary(tenantId: string): Promise<LearningProposalStatusSummary>;
  recordEvaluation(
    tenantId: string,
    id: string,
    params: RecordLearningProposalEvaluationParams,
  ): Promise<LearningProposalRecord | null>;
  approve(
    tenantId: string,
    id: string,
    approvedBy: string,
  ): Promise<LearningProposalRecord | null>;
  /**
   * Atomically changes `requires_approval` to `approved` and writes the
   * durable event consumed by the learning worker.
   */
  approveAndEnqueue(
    tenantId: string,
    id: string,
    approvedBy: string,
  ): Promise<ApproveLearningProposalResult | null>;
  /**
   * Atomically leases an approved proposal to one promoter. A lease expires
   * after a bounded interval so a process crash never leaves promotion stuck.
   */
  claimPromotion(
    tenantId: string,
    id: string,
    options?: PromotionClaimOptions,
  ): Promise<PromotionClaim | null>;
  markPromoted(
    tenantId: string,
    id: string,
    promotedVersionRef: string,
    promotionClaimToken: string,
  ): Promise<LearningProposalRecord | null>;
  markRolledBack(
    tenantId: string,
    id: string,
    rollbackVersionRef: string,
  ): Promise<LearningProposalRecord | null>;
}

const emptyLearningProposalStatusSummary =
  (): LearningProposalStatusSummary => ({
    total: 0,
    byStatus: {
      awaiting_evidence: 0,
      evaluating: 0,
      requires_approval: 0,
      approved: 0,
      rejected: 0,
      promoted: 0,
      rolled_back: 0,
    },
  });

const proposalStatusForDecision = (
  decision: LearningDecision,
): LearningProposalStatus => {
  switch (decision) {
    case "continue_experiment":
      return "awaiting_evidence";
    case "reject":
      return "rejected";
    case "requires_approval":
      return "requires_approval";
    case "promote":
      // A successful evidence gate only makes a proposal eligible. It does not
      // mutate production; markPromoted runs after an immutable version exists.
      return "approved";
  }
};

// ─── Component health ──────────────────────────────────────────────────────

export const runtimeHealthStateSchema = z.enum(runtimeHealthStateValues);
export type RuntimeHealthState = z.infer<typeof runtimeHealthStateSchema>;

export const healingActionSchema = z.enum(healingActionValues);
export type HealingAction = z.infer<typeof healingActionSchema>;

export const componentHealthRecordSchema = z.object({
  id: z.string().uuid(),
  tenantId: tenantIdSchema,
  componentId: nonEmptyText,
  idempotencyKey: nonEmptyText,
  state: runtimeHealthStateSchema,
  errorRate: z.number().min(0).max(1),
  consecutiveFailures: z.number().int().nonnegative(),
  p95LatencyMs: z.number().int().nonnegative(),
  stalenessSeconds: z.number().int().nonnegative(),
  dependencyAvailable: z.boolean(),
  fallbackAvailable: z.boolean(),
  lastKnownGoodAvailable: z.boolean(),
  lastKnownGoodVersionRef: z.string().nullable(),
  recoveryAttempts: z.number().int().nonnegative(),
  guardrailBreached: z.boolean(),
  action: healingActionSchema,
  allowExternalActions: z.boolean(),
  retryAfterSeconds: z.number().int().positive().nullable(),
  reasons: z.array(nonEmptyText),
  observedAt: z.date(),
  createdAt: z.date(),
});
export type ComponentHealthRecord = z.infer<typeof componentHealthRecordSchema>;

export const recordComponentHealthParamsSchema = componentHealthRecordSchema
  .omit({ id: true, tenantId: true, createdAt: true })
  .extend({
    lastKnownGoodVersionRef: z.string().trim().min(1).optional(),
    retryAfterSeconds: z.number().int().positive().optional(),
    observedAt: z.date().optional(),
  });
export type RecordComponentHealthParams = z.input<
  typeof recordComponentHealthParamsSchema
>;

const mapComponentHealth = (row: ComponentHealth): ComponentHealthRecord =>
  componentHealthRecordSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    componentId: row.componentId,
    idempotencyKey: row.idempotencyKey,
    state: row.state,
    errorRate: Number(row.errorRate),
    consecutiveFailures: row.consecutiveFailures,
    p95LatencyMs: row.p95LatencyMs,
    stalenessSeconds: row.stalenessSeconds,
    dependencyAvailable: row.dependencyAvailable,
    fallbackAvailable: row.fallbackAvailable,
    lastKnownGoodAvailable: row.lastKnownGoodAvailable,
    lastKnownGoodVersionRef: row.lastKnownGoodVersionRef ?? null,
    recoveryAttempts: row.recoveryAttempts,
    guardrailBreached: row.guardrailBreached,
    action: row.action,
    allowExternalActions: row.allowExternalActions,
    retryAfterSeconds: row.retryAfterSeconds ?? null,
    reasons: row.reasons,
    observedAt: row.observedAt,
    createdAt: row.createdAt,
  });

export interface RecordComponentHealthResult {
  health: ComponentHealthRecord;
  isDuplicate: boolean;
}

export interface ComponentHealthRepository {
  record(
    tenantId: string,
    params: RecordComponentHealthParams,
  ): Promise<RecordComponentHealthResult>;
  getByComponent(
    tenantId: string,
    componentId: string,
  ): Promise<ComponentHealthRecord | null>;
  listLatest(
    tenantId: string,
    limit?: number,
  ): Promise<ComponentHealthRecord[]>;
}

// ─── Incidents ─────────────────────────────────────────────────────────────

export const incidentSeveritySchema = z.enum(incidentSeverityValues);
export type IncidentSeverity = z.infer<typeof incidentSeveritySchema>;
export const incidentStatusSchema = z.enum(incidentStatusValues);
export type IncidentStatus = z.infer<typeof incidentStatusSchema>;

export const incidentRecordSchema = z.object({
  id: z.string().uuid(),
  tenantId: tenantIdSchema,
  incidentKey: nonEmptyText,
  componentId: nonEmptyText,
  severity: incidentSeveritySchema,
  status: incidentStatusSchema,
  title: nonEmptyText,
  summary: nonEmptyText,
  action: healingActionSchema.nullable(),
  rollbackVersionRef: z.string().nullable(),
  diagnosticMetadata: recordSchema,
  openedAt: z.date(),
  acknowledgedAt: z.date().nullable(),
  resolvedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type IncidentRecord = z.infer<typeof incidentRecordSchema>;

/** Safe founder/API projection. It intentionally excludes diagnosticMetadata. */
export const incidentSummarySchema = incidentRecordSchema.pick({
  id: true,
  tenantId: true,
  incidentKey: true,
  componentId: true,
  severity: true,
  status: true,
  title: true,
  summary: true,
  action: true,
  rollbackVersionRef: true,
  openedAt: true,
  acknowledgedAt: true,
  resolvedAt: true,
  createdAt: true,
  updatedAt: true,
});
export type IncidentSummary = z.infer<typeof incidentSummarySchema>;

export const toIncidentSummary = (record: IncidentRecord): IncidentSummary =>
  incidentSummarySchema.parse(record);

export const createIncidentParamsSchema = z.object({
  incidentKey: nonEmptyText,
  componentId: nonEmptyText,
  severity: incidentSeveritySchema,
  title: nonEmptyText,
  summary: nonEmptyText,
  action: healingActionSchema.optional(),
  rollbackVersionRef: z.string().trim().min(1).optional(),
  diagnosticMetadata: recordSchema.default({}),
  openedAt: z.date().optional(),
});
export type CreateIncidentParams = z.input<typeof createIncidentParamsSchema>;

export const transitionIncidentParamsSchema = z.object({
  summary: nonEmptyText.optional(),
  action: healingActionSchema.optional(),
  rollbackVersionRef: z.string().trim().min(1).optional(),
});
export type TransitionIncidentParams = z.input<
  typeof transitionIncidentParamsSchema
>;

const mapIncident = (row: Incident): IncidentRecord =>
  incidentRecordSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    incidentKey: row.incidentKey,
    componentId: row.componentId,
    severity: row.severity,
    status: row.status,
    title: row.title,
    summary: row.summary,
    action: row.action ?? null,
    rollbackVersionRef: row.rollbackVersionRef ?? null,
    diagnosticMetadata: row.diagnosticMetadata,
    openedAt: row.openedAt,
    acknowledgedAt: row.acknowledgedAt ?? null,
    resolvedAt: row.resolvedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

const incidentTransitions: Readonly<
  Record<IncidentStatus, readonly IncidentStatus[]>
> = {
  open: ["acknowledged", "mitigated", "resolved"],
  acknowledged: ["mitigated", "resolved"],
  mitigated: ["resolved"],
  resolved: [],
};

const assertIncidentTransition = (
  from: IncidentStatus,
  to: IncidentStatus,
): void => {
  if (!incidentTransitions[from].includes(to)) {
    throw new Error(`Illegal incident transition: ${from} -> ${to}`);
  }
};

export interface IncidentRepository {
  create(
    tenantId: string,
    params: CreateIncidentParams,
  ): Promise<IncidentRecord>;
  getById(tenantId: string, id: string): Promise<IncidentRecord | null>;
  listRecent(
    tenantId: string,
    limit?: number,
    status?: IncidentStatus,
  ): Promise<IncidentRecord[]>;
  transition(
    tenantId: string,
    id: string,
    fromStatus: IncidentStatus,
    toStatus: IncidentStatus,
    params?: TransitionIncidentParams,
  ): Promise<IncidentRecord | null>;
}

// ─── In-memory implementations ────────────────────────────────────────────
//
// These mirror the persistence invariants used by worker and route tests. They
// are intentionally strict about tenant ownership and lifecycle transitions so
// a test double cannot mask a production-only control-plane bug.

export class InMemoryExperimentRepository implements ExperimentRepository {
  private readonly experimentsById = new Map<string, ExperimentRecord>();
  private readonly experimentIdByKey = new Map<string, string>();
  private readonly assignmentsById = new Map<
    string,
    ExperimentAssignmentRecord
  >();
  private readonly assignmentIdByEntity = new Map<string, string>();
  private readonly observationsById = new Map<
    string,
    ExperimentObservationRecord
  >();
  private readonly observationIdByKey = new Map<string, string>();

  private experimentKey(tenantId: string, experimentKey: string): string {
    return `${tenantId}:${experimentKey}`;
  }

  private assignmentKey(
    tenantId: string,
    experimentId: string,
    entityType: string,
    entityId: string,
  ): string {
    return `${tenantId}:${experimentId}:${entityType}:${entityId}`;
  }

  private observationKey(
    tenantId: string,
    experimentId: string,
    idempotencyKey: string,
  ): string {
    return `${tenantId}:${experimentId}:${idempotencyKey}`;
  }

  async create(
    tenantId: string,
    params: CreateExperimentParams,
  ): Promise<ExperimentRecord> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsed = createExperimentParamsSchema.parse(params);
    const key = this.experimentKey(parsedTenantId, parsed.experimentKey);
    const existingId = this.experimentIdByKey.get(key);
    if (existingId) {
      const existing = this.experimentsById.get(existingId);
      if (existing) return existing;
    }

    const now = new Date();
    const record = experimentRecordSchema.parse({
      id: crypto.randomUUID(),
      tenantId: parsedTenantId,
      experimentKey: parsed.experimentKey,
      motion: parsed.motion,
      experimentType: parsed.experimentType,
      unitType: parsed.unitType,
      hypothesis: parsed.hypothesis,
      variantA: parsed.variantA,
      variantB: parsed.variantB,
      metricName: parsed.metricName,
      metricDirection: parsed.metricDirection,
      minSampleSize: parsed.minSampleSize,
      status: parsed.initialStatus,
      winner: null,
      confidence: null,
      inputSnapshot: parsed.inputSnapshot,
      modelVersion: parsed.modelVersion ?? null,
      promptVersion: parsed.promptVersion ?? null,
      playbookVersion: parsed.playbookVersion ?? null,
      policyVersion: parsed.policyVersion ?? null,
      createdBy: parsed.createdBy,
      startedAt:
        parsed.startedAt ?? (parsed.initialStatus === "running" ? now : null),
      endedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    this.experimentsById.set(record.id, record);
    this.experimentIdByKey.set(key, record.id);
    return record;
  }

  async getById(
    tenantId: string,
    id: string,
  ): Promise<ExperimentRecord | null> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const record = this.experimentsById.get(id);
    return record?.tenantId === parsedTenantId ? record : null;
  }

  async listRecent(
    tenantId: string,
    limit?: number,
  ): Promise<ExperimentRecord[]> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsedLimit = normalizeLimit(limit);
    return Array.from(this.experimentsById.values())
      .filter((record) => record.tenantId === parsedTenantId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, parsedLimit);
  }

  async getSummary(tenantId: string): Promise<ExperimentStatusSummary> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const result = emptyExperimentStatusSummary();
    for (const record of this.experimentsById.values()) {
      if (record.tenantId !== parsedTenantId) continue;
      result.total += 1;
      result.byStatus[record.status] += 1;
    }
    return result;
  }

  async transition(
    tenantId: string,
    id: string,
    fromStatus: ExperimentStatus,
    toStatus: ExperimentStatus,
    params: TransitionExperimentParams = {},
  ): Promise<ExperimentRecord | null> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsedParams = transitionExperimentParamsSchema.parse(params);
    assertExperimentTransition(fromStatus, toStatus);

    const existing = this.experimentsById.get(id);
    if (
      !existing ||
      existing.tenantId !== parsedTenantId ||
      existing.status !== fromStatus
    ) {
      return null;
    }

    const now = new Date();
    const terminal = toStatus === "concluded" || toStatus === "abandoned";
    const updated = experimentRecordSchema.parse({
      ...existing,
      status: toStatus,
      winner: parsedParams.winner ?? existing.winner,
      confidence: parsedParams.confidence ?? existing.confidence,
      startedAt:
        toStatus === "running"
          ? (existing.startedAt ?? now)
          : existing.startedAt,
      endedAt: terminal
        ? (parsedParams.endedAt ?? existing.endedAt ?? now)
        : existing.endedAt,
      updatedAt: now,
    });
    this.experimentsById.set(id, updated);
    return updated;
  }

  async assign(
    tenantId: string,
    params: AssignExperimentParams,
  ): Promise<AssignExperimentResult> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsed = assignExperimentParamsSchema.parse(params);
    const experiment = await this.getById(parsedTenantId, parsed.experimentId);
    if (!experiment)
      throw new Error("Experiment does not exist for this tenant.");
    if (experiment.status !== "draft" && experiment.status !== "running") {
      throw new Error(
        "Assignments are only allowed for draft or running experiments.",
      );
    }

    const key = this.assignmentKey(
      parsedTenantId,
      parsed.experimentId,
      parsed.entityType,
      parsed.entityId,
    );
    const existingId = this.assignmentIdByEntity.get(key);
    if (existingId) {
      const existing = this.assignmentsById.get(existingId);
      if (existing) return { assignment: existing, isExisting: true };
    }

    const now = new Date();
    const assignment = experimentAssignmentRecordSchema.parse({
      id: crypto.randomUUID(),
      tenantId: parsedTenantId,
      experimentId: parsed.experimentId,
      entityType: parsed.entityType,
      entityId: parsed.entityId,
      variant: parsed.variant,
      assignmentContext: parsed.assignmentContext,
      assignedAt: now,
      exposedAt: parsed.exposedAt ?? null,
      createdAt: now,
    });
    this.assignmentsById.set(assignment.id, assignment);
    this.assignmentIdByEntity.set(key, assignment.id);
    return { assignment, isExisting: false };
  }

  async recordObservation(
    tenantId: string,
    params: RecordExperimentObservationParams,
  ): Promise<ExperimentObservationRecord> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsed = recordExperimentObservationParamsSchema.parse(params);
    const experiment = await this.getById(parsedTenantId, parsed.experimentId);
    if (!experiment)
      throw new Error("Experiment does not exist for this tenant.");
    if (
      experiment.status !== "running" &&
      experiment.status !== "concluded" &&
      experiment.status !== "promoted" &&
      experiment.status !== "rolled_back"
    ) {
      throw new Error(
        "Observations require a running or completed experiment.",
      );
    }

    if (parsed.assignmentId) {
      const assignment = this.assignmentsById.get(parsed.assignmentId);
      if (
        !assignment ||
        assignment.tenantId !== parsedTenantId ||
        assignment.experimentId !== parsed.experimentId ||
        assignment.entityType !== parsed.entityType ||
        assignment.entityId !== parsed.entityId ||
        assignment.variant !== parsed.variant
      ) {
        throw new Error(
          "Observation assignment does not match the experiment unit.",
        );
      }
    }

    const key = this.observationKey(
      parsedTenantId,
      parsed.experimentId,
      parsed.idempotencyKey,
    );
    const existingId = this.observationIdByKey.get(key);
    if (existingId) {
      const existing = this.observationsById.get(existingId);
      if (existing) return existing;
    }

    const now = new Date();
    const record = experimentObservationRecordSchema.parse({
      id: crypto.randomUUID(),
      tenantId: parsedTenantId,
      experimentId: parsed.experimentId,
      assignmentId: parsed.assignmentId ?? null,
      idempotencyKey: parsed.idempotencyKey,
      entityType: parsed.entityType,
      entityId: parsed.entityId,
      variant: parsed.variant,
      metricName: parsed.metricName,
      metricValue: parsed.metricValue,
      isGuardrail: parsed.isGuardrail,
      attributionConfidence: parsed.attributionConfidence,
      attributionModel: parsed.attributionModel,
      source: parsed.source,
      costAmount: parsed.costAmount ?? null,
      costCurrency: parsed.costCurrency ?? null,
      observedOutcome: parsed.observedOutcome,
      evidence: parsed.evidence,
      observedAt: parsed.observedAt ?? now,
      createdAt: now,
    });
    this.observationsById.set(record.id, record);
    this.observationIdByKey.set(key, record.id);
    return record;
  }

  async recordOutcome(
    tenantId: string,
    params: RecordExperimentObservationParams,
  ): Promise<ExperimentObservationRecord> {
    return this.recordObservation(tenantId, params);
  }

  async listObservations(
    tenantId: string,
    experimentId: string,
    options: { metricName?: string; limit?: number } = {},
  ): Promise<ExperimentObservationRecord[]> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsedLimit = normalizeLimit(options.limit);
    return Array.from(this.observationsById.values())
      .filter(
        (record) =>
          record.tenantId === parsedTenantId &&
          record.experimentId === experimentId &&
          (options.metricName === undefined ||
            record.metricName === options.metricName),
      )
      .sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime())
      .slice(0, parsedLimit);
  }

  async summarizeEvidence(
    tenantId: string,
    experimentId: string,
    metricName: string,
    guardrailMetricName?: string,
  ): Promise<ExperimentEvidenceSummary | null> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const experiment = await this.getById(parsedTenantId, experimentId);
    if (!experiment) return null;
    const records = Array.from(this.observationsById.values()).filter(
      (record) =>
        record.tenantId === parsedTenantId &&
        record.experimentId === experimentId,
    );
    return summarizeEvidenceRecords(
      experimentId,
      metricName,
      records,
      guardrailMetricName,
    );
  }
}

const mean = (values: number[]): number | null => {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
};

const summarizeEvidenceRecords = (
  experimentId: string,
  metricName: string,
  records: ExperimentObservationRecord[],
  guardrailMetricName?: string,
): ExperimentEvidenceSummary | null => {
  const outcomeRows = records.filter(
    (record) => !record.isGuardrail && record.metricName === metricName,
  );
  const baselineRows = outcomeRows.filter((record) => record.variant === "a");
  const candidateRows = outcomeRows.filter((record) => record.variant === "b");
  const baselineMetric = mean(baselineRows.map((record) => record.metricValue));
  const candidateMetric = mean(
    candidateRows.map((record) => record.metricValue),
  );
  if (baselineMetric === null || candidateMetric === null) return null;

  const guardrailRows = guardrailMetricName
    ? records.filter(
        (record) =>
          record.isGuardrail && record.metricName === guardrailMetricName,
      )
    : [];
  const baselineGuardrailMetric = mean(
    guardrailRows
      .filter((record) => record.variant === "a")
      .map((record) => record.metricValue),
  );
  const candidateGuardrailMetric = mean(
    guardrailRows
      .filter((record) => record.variant === "b")
      .map((record) => record.metricValue),
  );
  const rawRegression =
    baselineGuardrailMetric === null || candidateGuardrailMetric === null
      ? 0
      : candidateGuardrailMetric - baselineGuardrailMetric;

  return {
    experimentId,
    metricName,
    evidenceCount: outcomeRows.length,
    uniqueEntities: new Set(
      outcomeRows.map((record) => `${record.entityType}:${record.entityId}`),
    ).size,
    baselineMetric,
    candidateMetric,
    meanAttributionConfidence:
      mean(outcomeRows.map((record) => record.attributionConfidence)) ?? 0,
    baselineGuardrailMetric,
    candidateGuardrailMetric,
    worstGuardrailRegression: Math.max(0, rawRegression),
  };
};

export class InMemoryLearningProposalRepository
  implements LearningProposalRepository
{
  private readonly recordsById = new Map<string, LearningProposalRecord>();
  private readonly recordIdByKey = new Map<string, string>();

  constructor(
    private readonly outboxRepository: Pick<
      OutboxRepository,
      "enqueue"
    > = new InMemoryOutboxRepository(),
  ) {}

  private key(tenantId: string, proposalKey: string): string {
    return `${tenantId}:${proposalKey}`;
  }

  /**
   * Synchronous lookup is intentional for state-transition CAS operations.
   * It keeps the in-memory implementation single-writer at the same boundary
   * as the conditional Postgres updates, rather than yielding between read
   * and write when concurrent test consumers call the repository.
   */
  private findScopedRecord(
    tenantId: string,
    id: string,
  ): LearningProposalRecord | null {
    const record = this.recordsById.get(id);
    return record?.tenantId === tenantId ? record : null;
  }

  async create(
    tenantId: string,
    params: CreateLearningProposalParams,
  ): Promise<LearningProposalRecord> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsed = createLearningProposalParamsSchema.parse(params);
    const key = this.key(parsedTenantId, parsed.proposalKey);
    const existingId = this.recordIdByKey.get(key);
    if (existingId) {
      const existing = this.recordsById.get(existingId);
      if (existing) return existing;
    }
    const now = new Date();
    const record = learningProposalRecordSchema.parse({
      id: crypto.randomUUID(),
      tenantId: parsedTenantId,
      proposalKey: parsed.proposalKey,
      experimentId: parsed.experimentId ?? null,
      targetType: parsed.targetType,
      targetId: parsed.targetId,
      risk: parsed.risk,
      status: "awaiting_evidence",
      proposalPayload: parsed.proposalPayload,
      evidenceSnapshot: {},
      evaluationSnapshot: {},
      decision: null,
      decisionReasons: [],
      baseVersionRef: parsed.baseVersionRef ?? null,
      candidateVersionRef: parsed.candidateVersionRef ?? null,
      promotedVersionRef: null,
      rollbackVersionRef: null,
      humanApprovedBy: null,
      humanApprovedAt: null,
      promotionClaimToken: null,
      promotionClaimExpiresAt: null,
      createdBy: parsed.createdBy,
      evaluatedAt: null,
      promotedAt: null,
      rolledBackAt: null,
      createdAt: now,
      updatedAt: now,
    });
    this.recordsById.set(record.id, record);
    this.recordIdByKey.set(key, record.id);
    return record;
  }

  async getById(
    tenantId: string,
    id: string,
  ): Promise<LearningProposalRecord | null> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    return this.findScopedRecord(parsedTenantId, id);
  }

  async getByProposalKey(
    tenantId: string,
    proposalKey: string,
  ): Promise<LearningProposalRecord | null> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const id = this.recordIdByKey.get(this.key(parsedTenantId, proposalKey));
    return id ? await this.getById(parsedTenantId, id) : null;
  }

  async listRecent(
    tenantId: string,
    limit?: number,
    status?: LearningProposalStatus,
  ): Promise<LearningProposalRecord[]> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsedLimit = normalizeLimit(limit);
    return Array.from(this.recordsById.values())
      .filter(
        (record) =>
          record.tenantId === parsedTenantId &&
          (status === undefined || record.status === status),
      )
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, parsedLimit);
  }

  async getSummary(tenantId: string): Promise<LearningProposalStatusSummary> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const result = emptyLearningProposalStatusSummary();
    for (const record of this.recordsById.values()) {
      if (record.tenantId !== parsedTenantId) continue;
      result.total += 1;
      result.byStatus[record.status] += 1;
    }
    return result;
  }

  async recordEvaluation(
    tenantId: string,
    id: string,
    params: RecordLearningProposalEvaluationParams,
  ): Promise<LearningProposalRecord | null> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsed = recordLearningProposalEvaluationParamsSchema.parse(params);
    const existing = this.findScopedRecord(parsedTenantId, id);
    const now = new Date();
    if (
      !existing ||
      (existing.status !== "awaiting_evidence" &&
        existing.status !== "evaluating" &&
        existing.status !== "requires_approval" &&
        // Evidence is intentionally re-evaluated after a human approval
        // request. An approval is not a waiver for a later guardrail breach.
        existing.status !== "approved") ||
      hasActivePromotionClaim(existing, now)
    ) {
      return null;
    }
    const updated = learningProposalRecordSchema.parse({
      ...existing,
      status: proposalStatusForDecision(parsed.decision),
      decision: parsed.decision,
      evidenceSnapshot: parsed.evidenceSnapshot,
      evaluationSnapshot: parsed.evaluationSnapshot,
      decisionReasons: parsed.decisionReasons,
      promotionClaimToken: null,
      promotionClaimExpiresAt: null,
      evaluatedAt: now,
      updatedAt: now,
    });
    this.recordsById.set(id, updated);
    return updated;
  }

  async approve(
    tenantId: string,
    id: string,
    approvedBy: string,
  ): Promise<LearningProposalRecord | null> {
    const result = await this.approveAndEnqueue(tenantId, id, approvedBy);
    return result?.proposal ?? null;
  }

  async approveAndEnqueue(
    tenantId: string,
    id: string,
    approvedBy: string,
  ): Promise<ApproveLearningProposalResult | null> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsedApprovedBy = nonEmptyText.parse(approvedBy);
    const existing = this.findScopedRecord(parsedTenantId, id);
    if (!existing || existing.status !== "requires_approval") return null;
    const now = new Date();
    const updated = learningProposalRecordSchema.parse({
      ...existing,
      status: "approved",
      humanApprovedBy: parsedApprovedBy,
      humanApprovedAt: now,
      promotionClaimToken: null,
      promotionClaimExpiresAt: null,
      updatedAt: now,
    });

    // Mirror the production all-or-nothing boundary for unit tests. The
    // proposal is restored if the injected outbox rejects its write.
    this.recordsById.set(id, updated);
    try {
      const outboxEvent = await this.outboxRepository.enqueue(
        learningProposalApprovalOutboxCommand(updated),
      );
      return { proposal: updated, outboxEvent };
    } catch (error) {
      this.recordsById.set(id, existing);
      throw error;
    }
  }

  async claimPromotion(
    tenantId: string,
    id: string,
    options: PromotionClaimOptions = {},
  ): Promise<PromotionClaim | null> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsedOptions = promotionClaimOptionsSchema.parse(options);
    const now = parsedOptions.now ?? new Date();
    const existing = this.findScopedRecord(parsedTenantId, id);
    if (
      !existing ||
      existing.status !== "approved" ||
      hasActivePromotionClaim(existing, now)
    ) {
      return null;
    }

    const token = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + parsedOptions.leaseMs);
    const proposal = learningProposalRecordSchema.parse({
      ...existing,
      promotionClaimToken: token,
      promotionClaimExpiresAt: expiresAt,
      updatedAt: now,
    });
    this.recordsById.set(id, proposal);
    return { proposal, token, expiresAt };
  }

  async markPromoted(
    tenantId: string,
    id: string,
    promotedVersionRef: string,
    promotionClaimToken: string,
  ): Promise<LearningProposalRecord | null> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const versionRef = nonEmptyText.parse(promotedVersionRef);
    const claimToken = z.string().uuid().parse(promotionClaimToken);
    const existing = this.findScopedRecord(parsedTenantId, id);
    const now = new Date();
    if (
      !existing ||
      existing.status !== "approved" ||
      existing.promotionClaimToken !== claimToken ||
      !hasActivePromotionClaim(existing, now)
    ) {
      return null;
    }
    const updated = learningProposalRecordSchema.parse({
      ...existing,
      status: "promoted",
      promotedVersionRef: versionRef,
      promotionClaimToken: null,
      promotionClaimExpiresAt: null,
      promotedAt: now,
      updatedAt: now,
    });
    this.recordsById.set(id, updated);
    return updated;
  }

  async markRolledBack(
    tenantId: string,
    id: string,
    rollbackVersionRef: string,
  ): Promise<LearningProposalRecord | null> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const versionRef = nonEmptyText.parse(rollbackVersionRef);
    const existing = this.findScopedRecord(parsedTenantId, id);
    if (!existing || existing.status !== "promoted") return null;
    const now = new Date();
    const updated = learningProposalRecordSchema.parse({
      ...existing,
      status: "rolled_back",
      rollbackVersionRef: versionRef,
      rolledBackAt: now,
      updatedAt: now,
    });
    this.recordsById.set(id, updated);
    return updated;
  }
}

export class InMemoryComponentHealthRepository
  implements ComponentHealthRepository
{
  private readonly records = new Map<string, ComponentHealthRecord>();
  private readonly recordIdByKey = new Map<string, string>();

  private key(
    tenantId: string,
    componentId: string,
    idempotencyKey: string,
  ): string {
    return `${tenantId}:${componentId}:${idempotencyKey}`;
  }

  async record(
    tenantId: string,
    params: RecordComponentHealthParams,
  ): Promise<RecordComponentHealthResult> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsed = recordComponentHealthParamsSchema.parse(params);
    const key = this.key(
      parsedTenantId,
      parsed.componentId,
      parsed.idempotencyKey,
    );
    const existingId = this.recordIdByKey.get(key);
    if (existingId) {
      const existing = this.records.get(existingId);
      if (existing) return { health: existing, isDuplicate: true };
    }
    const now = new Date();
    const record = componentHealthRecordSchema.parse({
      ...parsed,
      id: crypto.randomUUID(),
      tenantId: parsedTenantId,
      lastKnownGoodVersionRef: parsed.lastKnownGoodVersionRef ?? null,
      retryAfterSeconds: parsed.retryAfterSeconds ?? null,
      observedAt: parsed.observedAt ?? now,
      createdAt: now,
    });
    this.records.set(record.id, record);
    this.recordIdByKey.set(key, record.id);
    return { health: record, isDuplicate: false };
  }

  async getByComponent(
    tenantId: string,
    componentId: string,
  ): Promise<ComponentHealthRecord | null> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    return (
      Array.from(this.records.values())
        .filter(
          (record) =>
            record.tenantId === parsedTenantId &&
            record.componentId === componentId,
        )
        .sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime())[0] ??
      null
    );
  }

  async listLatest(
    tenantId: string,
    limit?: number,
  ): Promise<ComponentHealthRecord[]> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsedLimit = normalizeLimit(limit);
    const latestByComponent = new Map<string, ComponentHealthRecord>();
    for (const record of this.records.values()) {
      if (record.tenantId !== parsedTenantId) continue;
      const prior = latestByComponent.get(record.componentId);
      if (!prior || prior.observedAt.getTime() < record.observedAt.getTime()) {
        latestByComponent.set(record.componentId, record);
      }
    }
    return Array.from(latestByComponent.values())
      .sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime())
      .slice(0, parsedLimit);
  }
}

export class InMemoryIncidentRepository implements IncidentRepository {
  private readonly recordsById = new Map<string, IncidentRecord>();
  private readonly recordIdByKey = new Map<string, string>();

  private key(tenantId: string, incidentKey: string): string {
    return `${tenantId}:${incidentKey}`;
  }

  async create(
    tenantId: string,
    params: CreateIncidentParams,
  ): Promise<IncidentRecord> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsed = createIncidentParamsSchema.parse(params);
    const key = this.key(parsedTenantId, parsed.incidentKey);
    const existingId = this.recordIdByKey.get(key);
    if (existingId) {
      const existing = this.recordsById.get(existingId);
      if (existing) return existing;
    }
    const now = new Date();
    const record = incidentRecordSchema.parse({
      id: crypto.randomUUID(),
      tenantId: parsedTenantId,
      incidentKey: parsed.incidentKey,
      componentId: parsed.componentId,
      severity: parsed.severity,
      status: "open",
      title: parsed.title,
      summary: parsed.summary,
      action: parsed.action ?? null,
      rollbackVersionRef: parsed.rollbackVersionRef ?? null,
      diagnosticMetadata: parsed.diagnosticMetadata,
      openedAt: parsed.openedAt ?? now,
      acknowledgedAt: null,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    this.recordsById.set(record.id, record);
    this.recordIdByKey.set(key, record.id);
    return record;
  }

  async getById(tenantId: string, id: string): Promise<IncidentRecord | null> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const record = this.recordsById.get(id);
    return record?.tenantId === parsedTenantId ? record : null;
  }

  async listRecent(
    tenantId: string,
    limit?: number,
    status?: IncidentStatus,
  ): Promise<IncidentRecord[]> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsedLimit = normalizeLimit(limit);
    return Array.from(this.recordsById.values())
      .filter(
        (record) =>
          record.tenantId === parsedTenantId &&
          (status === undefined || record.status === status),
      )
      .sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime())
      .slice(0, parsedLimit);
  }

  async transition(
    tenantId: string,
    id: string,
    fromStatus: IncidentStatus,
    toStatus: IncidentStatus,
    params: TransitionIncidentParams = {},
  ): Promise<IncidentRecord | null> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsedParams = transitionIncidentParamsSchema.parse(params);
    assertIncidentTransition(fromStatus, toStatus);
    const existing = await this.getById(parsedTenantId, id);
    if (!existing || existing.status !== fromStatus) return null;
    const now = new Date();
    const updated = incidentRecordSchema.parse({
      ...existing,
      status: toStatus,
      summary: parsedParams.summary ?? existing.summary,
      action: parsedParams.action ?? existing.action,
      rollbackVersionRef:
        parsedParams.rollbackVersionRef ?? existing.rollbackVersionRef,
      acknowledgedAt:
        toStatus === "acknowledged"
          ? (existing.acknowledgedAt ?? now)
          : existing.acknowledgedAt,
      resolvedAt: toStatus === "resolved" ? now : existing.resolvedAt,
      updatedAt: now,
    });
    this.recordsById.set(id, updated);
    return updated;
  }
}

// ─── Postgres implementations ──────────────────────────────────────────────

export class PostgresExperimentRepository implements ExperimentRepository {
  constructor(
    private readonly db: GrowthOsDb,
    private readonly context: Partial<TenantContext> = {},
  ) {}

  private withTenant<T>(tenantId: string, fn: (tx: TxClient) => Promise<T>) {
    return withTenantContext(this.db, tenantId, this.context, fn);
  }

  async create(
    tenantId: string,
    params: CreateExperimentParams,
  ): Promise<ExperimentRecord> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsed = createExperimentParamsSchema.parse(params);
    return this.withTenant(parsedTenantId, async (tx) => {
      const now = new Date();
      const rows = await tx
        .insert(experiments)
        .values({
          tenantId: parsedTenantId,
          experimentKey: parsed.experimentKey,
          motion: parsed.motion,
          experimentType: parsed.experimentType,
          unitType: parsed.unitType,
          hypothesis: parsed.hypothesis,
          variantA: parsed.variantA,
          variantB: parsed.variantB,
          metricName: parsed.metricName,
          metricDirection: parsed.metricDirection,
          minSampleSize: parsed.minSampleSize,
          status: parsed.initialStatus,
          inputSnapshot: parsed.inputSnapshot,
          modelVersion: parsed.modelVersion ?? null,
          promptVersion: parsed.promptVersion ?? null,
          playbookVersion: parsed.playbookVersion ?? null,
          policyVersion: parsed.policyVersion ?? null,
          createdBy: parsed.createdBy,
          startedAt:
            parsed.startedAt ??
            (parsed.initialStatus === "running" ? now : null),
        })
        .onConflictDoNothing({
          target: [experiments.tenantId, experiments.experimentKey],
        })
        .returning();
      if (rows[0]) return mapExperiment(rows[0]);

      const [existing] = await tx
        .select()
        .from(experiments)
        .where(
          and(
            eq(experiments.tenantId, parsedTenantId),
            eq(experiments.experimentKey, parsed.experimentKey),
          ),
        )
        .limit(1);
      if (!existing) throw new Error("Experiment create returned no row.");
      return mapExperiment(existing);
    });
  }

  async getById(
    tenantId: string,
    id: string,
  ): Promise<ExperimentRecord | null> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsedId = z.string().uuid().parse(id);
    return this.withTenant(parsedTenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(experiments)
        .where(
          and(
            eq(experiments.tenantId, parsedTenantId),
            eq(experiments.id, parsedId),
          ),
        )
        .limit(1);
      return row ? mapExperiment(row) : null;
    });
  }

  async listRecent(
    tenantId: string,
    limit?: number,
  ): Promise<ExperimentRecord[]> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsedLimit = normalizeLimit(limit);
    return this.withTenant(parsedTenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(experiments)
        .where(eq(experiments.tenantId, parsedTenantId))
        .orderBy(desc(experiments.updatedAt))
        .limit(parsedLimit);
      return rows.map(mapExperiment);
    });
  }

  async getSummary(tenantId: string): Promise<ExperimentStatusSummary> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    return this.withTenant(parsedTenantId, async (tx) => {
      const rows = await tx
        .select({ status: experiments.status, total: count() })
        .from(experiments)
        .where(eq(experiments.tenantId, parsedTenantId))
        .groupBy(experiments.status);
      const result = emptyExperimentStatusSummary();
      for (const row of rows) {
        result.byStatus[row.status] = Number(row.total);
        result.total += Number(row.total);
      }
      return result;
    });
  }

  async transition(
    tenantId: string,
    id: string,
    fromStatus: ExperimentStatus,
    toStatus: ExperimentStatus,
    params: TransitionExperimentParams = {},
  ): Promise<ExperimentRecord | null> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsedId = z.string().uuid().parse(id);
    const parsedParams = transitionExperimentParamsSchema.parse(params);
    assertExperimentTransition(fromStatus, toStatus);

    return this.withTenant(parsedTenantId, async (tx) => {
      const [current] = await tx
        .select()
        .from(experiments)
        .where(
          and(
            eq(experiments.tenantId, parsedTenantId),
            eq(experiments.id, parsedId),
            eq(experiments.status, fromStatus),
          ),
        )
        .limit(1);
      if (!current) return null;

      const now = new Date();
      const isConclusion = toStatus === "concluded" || toStatus === "abandoned";
      const [updated] = await tx
        .update(experiments)
        .set({
          status: toStatus,
          winner: parsedParams.winner ?? current.winner,
          confidence:
            parsedParams.confidence === undefined
              ? current.confidence
              : String(parsedParams.confidence),
          startedAt:
            toStatus === "running"
              ? (current.startedAt ?? now)
              : current.startedAt,
          endedAt: isConclusion
            ? (parsedParams.endedAt ?? current.endedAt ?? now)
            : current.endedAt,
          updatedAt: now,
        })
        .where(
          and(
            eq(experiments.tenantId, parsedTenantId),
            eq(experiments.id, parsedId),
            eq(experiments.status, fromStatus),
          ),
        )
        .returning();
      return updated ? mapExperiment(updated) : null;
    });
  }

  async assign(
    tenantId: string,
    params: AssignExperimentParams,
  ): Promise<AssignExperimentResult> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsed = assignExperimentParamsSchema.parse(params);
    return this.withTenant(parsedTenantId, async (tx) => {
      const [experiment] = await tx
        .select({ status: experiments.status })
        .from(experiments)
        .where(
          and(
            eq(experiments.tenantId, parsedTenantId),
            eq(experiments.id, parsed.experimentId),
          ),
        )
        .limit(1);
      if (!experiment)
        throw new Error("Experiment does not exist for this tenant.");
      if (experiment.status !== "draft" && experiment.status !== "running") {
        throw new Error(
          "Assignments are only allowed for draft or running experiments.",
        );
      }

      const rows = await tx
        .insert(experimentAssignments)
        .values({
          tenantId: parsedTenantId,
          experimentId: parsed.experimentId,
          entityType: parsed.entityType,
          entityId: parsed.entityId,
          variant: parsed.variant,
          assignmentContext: parsed.assignmentContext,
          exposedAt: parsed.exposedAt ?? null,
        })
        .onConflictDoNothing({
          target: [
            experimentAssignments.tenantId,
            experimentAssignments.experimentId,
            experimentAssignments.entityType,
            experimentAssignments.entityId,
          ],
        })
        .returning();
      if (rows[0])
        return { assignment: mapAssignment(rows[0]), isExisting: false };

      const [existing] = await tx
        .select()
        .from(experimentAssignments)
        .where(
          and(
            eq(experimentAssignments.tenantId, parsedTenantId),
            eq(experimentAssignments.experimentId, parsed.experimentId),
            eq(experimentAssignments.entityType, parsed.entityType),
            eq(experimentAssignments.entityId, parsed.entityId),
          ),
        )
        .limit(1);
      if (!existing) throw new Error("Experiment assignment returned no row.");
      return { assignment: mapAssignment(existing), isExisting: true };
    });
  }

  async recordObservation(
    tenantId: string,
    params: RecordExperimentObservationParams,
  ): Promise<ExperimentObservationRecord> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsed = recordExperimentObservationParamsSchema.parse(params);
    return this.withTenant(parsedTenantId, async (tx) => {
      const [experiment] = await tx
        .select({ status: experiments.status })
        .from(experiments)
        .where(
          and(
            eq(experiments.tenantId, parsedTenantId),
            eq(experiments.id, parsed.experimentId),
          ),
        )
        .limit(1);
      if (!experiment)
        throw new Error("Experiment does not exist for this tenant.");
      if (
        experiment.status !== "running" &&
        experiment.status !== "concluded" &&
        experiment.status !== "promoted" &&
        experiment.status !== "rolled_back"
      ) {
        throw new Error(
          "Observations require a running or completed experiment.",
        );
      }

      if (parsed.assignmentId) {
        const [assignment] = await tx
          .select()
          .from(experimentAssignments)
          .where(
            and(
              eq(experimentAssignments.tenantId, parsedTenantId),
              eq(experimentAssignments.id, parsed.assignmentId),
              eq(experimentAssignments.experimentId, parsed.experimentId),
            ),
          )
          .limit(1);
        if (
          !assignment ||
          assignment.entityType !== parsed.entityType ||
          assignment.entityId !== parsed.entityId ||
          assignment.variant !== parsed.variant
        ) {
          throw new Error(
            "Observation assignment does not match the experiment unit.",
          );
        }
      }

      const rows = await tx
        .insert(experimentObservations)
        .values({
          tenantId: parsedTenantId,
          experimentId: parsed.experimentId,
          assignmentId: parsed.assignmentId ?? null,
          idempotencyKey: parsed.idempotencyKey,
          entityType: parsed.entityType,
          entityId: parsed.entityId,
          variant: parsed.variant,
          metricName: parsed.metricName,
          metricValue: String(parsed.metricValue),
          isGuardrail: parsed.isGuardrail,
          attributionConfidence: String(parsed.attributionConfidence),
          attributionModel: parsed.attributionModel,
          source: parsed.source,
          costAmount:
            parsed.costAmount === undefined ? null : String(parsed.costAmount),
          costCurrency: parsed.costCurrency ?? null,
          observedOutcome: parsed.observedOutcome,
          evidence: parsed.evidence,
          observedAt: parsed.observedAt ?? new Date(),
        })
        .onConflictDoNothing({
          target: [
            experimentObservations.tenantId,
            experimentObservations.experimentId,
            experimentObservations.idempotencyKey,
          ],
        })
        .returning();
      if (rows[0]) return mapObservation(rows[0]);

      const [existing] = await tx
        .select()
        .from(experimentObservations)
        .where(
          and(
            eq(experimentObservations.tenantId, parsedTenantId),
            eq(experimentObservations.experimentId, parsed.experimentId),
            eq(experimentObservations.idempotencyKey, parsed.idempotencyKey),
          ),
        )
        .limit(1);
      if (!existing) throw new Error("Experiment observation returned no row.");
      return mapObservation(existing);
    });
  }

  async recordOutcome(
    tenantId: string,
    params: RecordExperimentObservationParams,
  ): Promise<ExperimentObservationRecord> {
    return this.recordObservation(tenantId, params);
  }

  async listObservations(
    tenantId: string,
    experimentId: string,
    options: { metricName?: string; limit?: number } = {},
  ): Promise<ExperimentObservationRecord[]> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsedExperimentId = z.string().uuid().parse(experimentId);
    const parsedLimit = normalizeLimit(options.limit);
    return this.withTenant(parsedTenantId, async (tx) => {
      const conditions = [
        eq(experimentObservations.tenantId, parsedTenantId),
        eq(experimentObservations.experimentId, parsedExperimentId),
      ];
      if (options.metricName !== undefined) {
        conditions.push(
          eq(
            experimentObservations.metricName,
            nonEmptyText.parse(options.metricName),
          ),
        );
      }
      const rows = await tx
        .select()
        .from(experimentObservations)
        .where(and(...conditions))
        .orderBy(desc(experimentObservations.observedAt))
        .limit(parsedLimit);
      return rows.map(mapObservation);
    });
  }

  async summarizeEvidence(
    tenantId: string,
    experimentId: string,
    metricName: string,
    guardrailMetricName?: string,
  ): Promise<ExperimentEvidenceSummary | null> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsedExperimentId = z.string().uuid().parse(experimentId);
    const parsedMetricName = nonEmptyText.parse(metricName);
    const parsedGuardrailMetricName =
      guardrailMetricName === undefined
        ? undefined
        : nonEmptyText.parse(guardrailMetricName);
    return this.withTenant(parsedTenantId, async (tx) => {
      const [experiment] = await tx
        .select({ id: experiments.id })
        .from(experiments)
        .where(
          and(
            eq(experiments.tenantId, parsedTenantId),
            eq(experiments.id, parsedExperimentId),
          ),
        )
        .limit(1);
      if (!experiment) return null;

      const [outcome] = await tx
        .select({
          evidenceCount: count(),
          uniqueEntities: sql<number>`count(DISTINCT (${experimentObservations.entityType}, ${experimentObservations.entityId}))`,
          baselineMetric: sql<
            string | null
          >`avg(CASE WHEN ${experimentObservations.variant} = 'a' THEN ${experimentObservations.metricValue} END)`,
          candidateMetric: sql<
            string | null
          >`avg(CASE WHEN ${experimentObservations.variant} = 'b' THEN ${experimentObservations.metricValue} END)`,
          meanAttributionConfidence: avg(
            experimentObservations.attributionConfidence,
          ),
        })
        .from(experimentObservations)
        .where(
          and(
            eq(experimentObservations.tenantId, parsedTenantId),
            eq(experimentObservations.experimentId, parsedExperimentId),
            eq(experimentObservations.metricName, parsedMetricName),
            eq(experimentObservations.isGuardrail, false),
          ),
        );
      if (
        !outcome ||
        outcome.baselineMetric === null ||
        outcome.candidateMetric === null
      ) {
        return null;
      }

      let baselineGuardrailMetric: number | null = null;
      let candidateGuardrailMetric: number | null = null;
      if (parsedGuardrailMetricName) {
        const [guardrail] = await tx
          .select({
            baselineMetric: sql<
              string | null
            >`avg(CASE WHEN ${experimentObservations.variant} = 'a' THEN ${experimentObservations.metricValue} END)`,
            candidateMetric: sql<
              string | null
            >`avg(CASE WHEN ${experimentObservations.variant} = 'b' THEN ${experimentObservations.metricValue} END)`,
          })
          .from(experimentObservations)
          .where(
            and(
              eq(experimentObservations.tenantId, parsedTenantId),
              eq(experimentObservations.experimentId, parsedExperimentId),
              eq(experimentObservations.metricName, parsedGuardrailMetricName),
              eq(experimentObservations.isGuardrail, true),
            ),
          );
        baselineGuardrailMetric =
          guardrail?.baselineMetric === null ||
          guardrail?.baselineMetric === undefined
            ? null
            : Number(guardrail.baselineMetric);
        candidateGuardrailMetric =
          guardrail?.candidateMetric === null ||
          guardrail?.candidateMetric === undefined
            ? null
            : Number(guardrail.candidateMetric);
      }

      return {
        experimentId: parsedExperimentId,
        metricName: parsedMetricName,
        evidenceCount: Number(outcome.evidenceCount),
        uniqueEntities: Number(outcome.uniqueEntities),
        baselineMetric: Number(outcome.baselineMetric),
        candidateMetric: Number(outcome.candidateMetric),
        meanAttributionConfidence: Number(
          outcome.meanAttributionConfidence ?? 0,
        ),
        baselineGuardrailMetric,
        candidateGuardrailMetric,
        worstGuardrailRegression:
          baselineGuardrailMetric === null || candidateGuardrailMetric === null
            ? 0
            : Math.max(0, candidateGuardrailMetric - baselineGuardrailMetric),
      };
    });
  }
}

export class PostgresLearningProposalRepository
  implements LearningProposalRepository
{
  constructor(
    private readonly db: GrowthOsDb,
    private readonly context: Partial<TenantContext> = {},
  ) {}

  private withTenant<T>(tenantId: string, fn: (tx: TxClient) => Promise<T>) {
    return withTenantContext(this.db, tenantId, this.context, fn);
  }

  async create(
    tenantId: string,
    params: CreateLearningProposalParams,
  ): Promise<LearningProposalRecord> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsed = createLearningProposalParamsSchema.parse(params);
    return this.withTenant(parsedTenantId, async (tx) => {
      const rows = await tx
        .insert(learningProposals)
        .values({
          tenantId: parsedTenantId,
          proposalKey: parsed.proposalKey,
          experimentId: parsed.experimentId ?? null,
          targetType: parsed.targetType,
          targetId: parsed.targetId,
          risk: parsed.risk,
          proposalPayload: parsed.proposalPayload,
          baseVersionRef: parsed.baseVersionRef ?? null,
          candidateVersionRef: parsed.candidateVersionRef ?? null,
          createdBy: parsed.createdBy,
        })
        .onConflictDoNothing({
          target: [learningProposals.tenantId, learningProposals.proposalKey],
        })
        .returning();
      if (rows[0]) return mapLearningProposal(rows[0]);
      const [existing] = await tx
        .select()
        .from(learningProposals)
        .where(
          and(
            eq(learningProposals.tenantId, parsedTenantId),
            eq(learningProposals.proposalKey, parsed.proposalKey),
          ),
        )
        .limit(1);
      if (!existing)
        throw new Error("Learning proposal create returned no row.");
      return mapLearningProposal(existing);
    });
  }

  async getById(
    tenantId: string,
    id: string,
  ): Promise<LearningProposalRecord | null> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsedId = z.string().uuid().parse(id);
    return this.withTenant(parsedTenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(learningProposals)
        .where(
          and(
            eq(learningProposals.tenantId, parsedTenantId),
            eq(learningProposals.id, parsedId),
          ),
        )
        .limit(1);
      return row ? mapLearningProposal(row) : null;
    });
  }

  async getByProposalKey(
    tenantId: string,
    proposalKey: string,
  ): Promise<LearningProposalRecord | null> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsedKey = nonEmptyText.parse(proposalKey);
    return this.withTenant(parsedTenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(learningProposals)
        .where(
          and(
            eq(learningProposals.tenantId, parsedTenantId),
            eq(learningProposals.proposalKey, parsedKey),
          ),
        )
        .limit(1);
      return row ? mapLearningProposal(row) : null;
    });
  }

  async listRecent(
    tenantId: string,
    limit?: number,
    status?: LearningProposalStatus,
  ): Promise<LearningProposalRecord[]> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsedLimit = normalizeLimit(limit);
    const parsedStatus =
      status === undefined
        ? undefined
        : learningProposalStatusSchema.parse(status);
    return this.withTenant(parsedTenantId, async (tx) => {
      const conditions = [eq(learningProposals.tenantId, parsedTenantId)];
      if (parsedStatus)
        conditions.push(eq(learningProposals.status, parsedStatus));
      const rows = await tx
        .select()
        .from(learningProposals)
        .where(and(...conditions))
        .orderBy(desc(learningProposals.updatedAt))
        .limit(parsedLimit);
      return rows.map(mapLearningProposal);
    });
  }

  async getSummary(tenantId: string): Promise<LearningProposalStatusSummary> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    return this.withTenant(parsedTenantId, async (tx) => {
      const rows = await tx
        .select({ status: learningProposals.status, total: count() })
        .from(learningProposals)
        .where(eq(learningProposals.tenantId, parsedTenantId))
        .groupBy(learningProposals.status);
      const result = emptyLearningProposalStatusSummary();
      for (const row of rows) {
        result.byStatus[row.status] = Number(row.total);
        result.total += Number(row.total);
      }
      return result;
    });
  }

  async recordEvaluation(
    tenantId: string,
    id: string,
    params: RecordLearningProposalEvaluationParams,
  ): Promise<LearningProposalRecord | null> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsedId = z.string().uuid().parse(id);
    const parsed = recordLearningProposalEvaluationParamsSchema.parse(params);
    return this.withTenant(parsedTenantId, async (tx) => {
      const now = new Date();
      const [current] = await tx
        .select({
          status: learningProposals.status,
          promotionClaimToken: learningProposals.promotionClaimToken,
          promotionClaimExpiresAt: learningProposals.promotionClaimExpiresAt,
        })
        .from(learningProposals)
        .where(
          and(
            eq(learningProposals.tenantId, parsedTenantId),
            eq(learningProposals.id, parsedId),
          ),
        )
        .limit(1);
      if (
        !current ||
        (current.status !== "awaiting_evidence" &&
          current.status !== "evaluating" &&
          current.status !== "requires_approval" &&
          // Founder approval must be followed by a fresh evidence read before
          // a version promotion can occur.
          current.status !== "approved") ||
        (current.promotionClaimToken !== null &&
          current.promotionClaimExpiresAt !== null &&
          current.promotionClaimExpiresAt.getTime() > now.getTime())
      ) {
        return null;
      }
      const [updated] = await tx
        .update(learningProposals)
        .set({
          status: proposalStatusForDecision(parsed.decision),
          decision: parsed.decision,
          evidenceSnapshot: parsed.evidenceSnapshot,
          evaluationSnapshot: parsed.evaluationSnapshot,
          decisionReasons: parsed.decisionReasons,
          promotionClaimToken: null,
          promotionClaimExpiresAt: null,
          evaluatedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(learningProposals.tenantId, parsedTenantId),
            eq(learningProposals.id, parsedId),
            eq(learningProposals.status, current.status),
            or(
              isNull(learningProposals.promotionClaimToken),
              lte(learningProposals.promotionClaimExpiresAt, now),
            ),
          ),
        )
        .returning();
      return updated ? mapLearningProposal(updated) : null;
    });
  }

  async approve(
    tenantId: string,
    id: string,
    approvedBy: string,
  ): Promise<LearningProposalRecord | null> {
    const result = await this.approveAndEnqueue(tenantId, id, approvedBy);
    return result?.proposal ?? null;
  }

  async approveAndEnqueue(
    tenantId: string,
    id: string,
    approvedBy: string,
  ): Promise<ApproveLearningProposalResult | null> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsedId = z.string().uuid().parse(id);
    const parsedApprovedBy = nonEmptyText.parse(approvedBy);
    return this.withTenant(parsedTenantId, async (tx) => {
      const now = new Date();
      const [updated] = await tx
        .update(learningProposals)
        .set({
          status: "approved",
          humanApprovedBy: parsedApprovedBy,
          humanApprovedAt: now,
          promotionClaimToken: null,
          promotionClaimExpiresAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(learningProposals.tenantId, parsedTenantId),
            eq(learningProposals.id, parsedId),
            eq(learningProposals.status, "requires_approval"),
          ),
        )
        .returning();
      if (!updated) return null;

      const proposal = mapLearningProposal(updated);
      const command = learningProposalApprovalOutboxCommand(proposal);
      await tx
        .insert(eventOutbox)
        .values({
          tenantId: command.tenantId,
          eventType: command.eventType,
          idempotencyKey: command.idempotencyKey,
          payload: command.payload,
        })
        .onConflictDoNothing({
          target: [
            eventOutbox.tenantId,
            eventOutbox.eventType,
            eventOutbox.idempotencyKey,
          ],
        });

      const [outboxEvent] = await tx
        .select()
        .from(eventOutbox)
        .where(
          and(
            eq(eventOutbox.tenantId, command.tenantId),
            eq(eventOutbox.eventType, command.eventType),
            eq(eventOutbox.idempotencyKey, command.idempotencyKey),
          ),
        )
        .limit(1);
      if (!outboxEvent) {
        throw new Error(
          "Learning proposal approval outbox event was not written.",
        );
      }

      // PostgreSQL delivers pg_notify only after this transaction commits, so
      // a listener can never observe the event before the approved proposal.
      await tx.execute(
        sql`SELECT pg_notify(
          'growthos_outbox_events',
          ${JSON.stringify({
            tenantId: command.tenantId,
            eventId: String(outboxEvent.id),
          })}
        )`,
      );

      return {
        proposal,
        outboxEvent: mapStoredOutboxEvent(outboxEvent),
      };
    });
  }

  async claimPromotion(
    tenantId: string,
    id: string,
    options: PromotionClaimOptions = {},
  ): Promise<PromotionClaim | null> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsedId = z.string().uuid().parse(id);
    const parsedOptions = promotionClaimOptionsSchema.parse(options);
    const now = parsedOptions.now ?? new Date();
    const token = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + parsedOptions.leaseMs);

    return this.withTenant(parsedTenantId, async (tx) => {
      const [updated] = await tx
        .update(learningProposals)
        .set({
          promotionClaimToken: token,
          promotionClaimExpiresAt: expiresAt,
          updatedAt: now,
        })
        .where(
          and(
            eq(learningProposals.tenantId, parsedTenantId),
            eq(learningProposals.id, parsedId),
            eq(learningProposals.status, "approved"),
            or(
              isNull(learningProposals.promotionClaimToken),
              lte(learningProposals.promotionClaimExpiresAt, now),
            ),
          ),
        )
        .returning();
      if (!updated) return null;

      return {
        proposal: mapLearningProposal(updated),
        token,
        expiresAt,
      };
    });
  }

  async markPromoted(
    tenantId: string,
    id: string,
    promotedVersionRef: string,
    promotionClaimToken: string,
  ): Promise<LearningProposalRecord | null> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsedId = z.string().uuid().parse(id);
    const versionRef = nonEmptyText.parse(promotedVersionRef);
    const claimToken = z.string().uuid().parse(promotionClaimToken);
    return this.withTenant(parsedTenantId, async (tx) => {
      const now = new Date();
      const [updated] = await tx
        .update(learningProposals)
        .set({
          status: "promoted",
          promotedVersionRef: versionRef,
          promotionClaimToken: null,
          promotionClaimExpiresAt: null,
          promotedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(learningProposals.tenantId, parsedTenantId),
            eq(learningProposals.id, parsedId),
            eq(learningProposals.status, "approved"),
            eq(learningProposals.promotionClaimToken, claimToken),
            gt(learningProposals.promotionClaimExpiresAt, now),
          ),
        )
        .returning();
      return updated ? mapLearningProposal(updated) : null;
    });
  }

  async markRolledBack(
    tenantId: string,
    id: string,
    rollbackVersionRef: string,
  ): Promise<LearningProposalRecord | null> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsedId = z.string().uuid().parse(id);
    const versionRef = nonEmptyText.parse(rollbackVersionRef);
    return this.withTenant(parsedTenantId, async (tx) => {
      const now = new Date();
      const [updated] = await tx
        .update(learningProposals)
        .set({
          status: "rolled_back",
          rollbackVersionRef: versionRef,
          rolledBackAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(learningProposals.tenantId, parsedTenantId),
            eq(learningProposals.id, parsedId),
            eq(learningProposals.status, "promoted"),
          ),
        )
        .returning();
      return updated ? mapLearningProposal(updated) : null;
    });
  }
}

export class PostgresComponentHealthRepository
  implements ComponentHealthRepository
{
  constructor(
    private readonly db: GrowthOsDb,
    private readonly context: Partial<TenantContext> = {},
  ) {}

  private withTenant<T>(tenantId: string, fn: (tx: TxClient) => Promise<T>) {
    return withTenantContext(this.db, tenantId, this.context, fn);
  }

  async record(
    tenantId: string,
    params: RecordComponentHealthParams,
  ): Promise<RecordComponentHealthResult> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsed = recordComponentHealthParamsSchema.parse(params);
    return this.withTenant(parsedTenantId, async (tx) => {
      const rows = await tx
        .insert(componentHealth)
        .values({
          tenantId: parsedTenantId,
          componentId: parsed.componentId,
          idempotencyKey: parsed.idempotencyKey,
          state: parsed.state,
          errorRate: String(parsed.errorRate),
          consecutiveFailures: parsed.consecutiveFailures,
          p95LatencyMs: parsed.p95LatencyMs,
          stalenessSeconds: parsed.stalenessSeconds,
          dependencyAvailable: parsed.dependencyAvailable,
          fallbackAvailable: parsed.fallbackAvailable,
          lastKnownGoodAvailable: parsed.lastKnownGoodAvailable,
          lastKnownGoodVersionRef: parsed.lastKnownGoodVersionRef ?? null,
          recoveryAttempts: parsed.recoveryAttempts,
          guardrailBreached: parsed.guardrailBreached,
          action: parsed.action,
          allowExternalActions: parsed.allowExternalActions,
          retryAfterSeconds: parsed.retryAfterSeconds ?? null,
          reasons: parsed.reasons,
          observedAt: parsed.observedAt ?? new Date(),
        })
        .onConflictDoNothing({
          target: [
            componentHealth.tenantId,
            componentHealth.componentId,
            componentHealth.idempotencyKey,
          ],
        })
        .returning();
      if (rows[0])
        return { health: mapComponentHealth(rows[0]), isDuplicate: false };

      const [existing] = await tx
        .select()
        .from(componentHealth)
        .where(
          and(
            eq(componentHealth.tenantId, parsedTenantId),
            eq(componentHealth.componentId, parsed.componentId),
            eq(componentHealth.idempotencyKey, parsed.idempotencyKey),
          ),
        )
        .limit(1);
      if (!existing)
        throw new Error("Component health record returned no row.");
      return { health: mapComponentHealth(existing), isDuplicate: true };
    });
  }

  async getByComponent(
    tenantId: string,
    componentId: string,
  ): Promise<ComponentHealthRecord | null> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsedComponentId = nonEmptyText.parse(componentId);
    return this.withTenant(parsedTenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(componentHealth)
        .where(
          and(
            eq(componentHealth.tenantId, parsedTenantId),
            eq(componentHealth.componentId, parsedComponentId),
          ),
        )
        .orderBy(
          desc(componentHealth.observedAt),
          desc(componentHealth.createdAt),
        )
        .limit(1);
      return row ? mapComponentHealth(row) : null;
    });
  }

  async listLatest(
    tenantId: string,
    limit?: number,
  ): Promise<ComponentHealthRecord[]> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsedLimit = normalizeLimit(limit);
    return this.withTenant(parsedTenantId, async (tx) => {
      // Postgres DISTINCT ON chooses the newest snapshot per component using
      // the tenant/component/observed_at index. We sort the resulting current
      // state in memory before applying the small founder-control-plane limit.
      const rows = await tx
        .selectDistinctOn([componentHealth.componentId])
        .from(componentHealth)
        .where(eq(componentHealth.tenantId, parsedTenantId))
        .orderBy(
          componentHealth.componentId,
          desc(componentHealth.observedAt),
          desc(componentHealth.createdAt),
        );
      return rows
        .map(mapComponentHealth)
        .sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime())
        .slice(0, parsedLimit);
    });
  }
}

export class PostgresIncidentRepository implements IncidentRepository {
  constructor(
    private readonly db: GrowthOsDb,
    private readonly context: Partial<TenantContext> = {},
  ) {}

  private withTenant<T>(tenantId: string, fn: (tx: TxClient) => Promise<T>) {
    return withTenantContext(this.db, tenantId, this.context, fn);
  }

  async create(
    tenantId: string,
    params: CreateIncidentParams,
  ): Promise<IncidentRecord> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsed = createIncidentParamsSchema.parse(params);
    return this.withTenant(parsedTenantId, async (tx) => {
      const rows = await tx
        .insert(incidents)
        .values({
          tenantId: parsedTenantId,
          incidentKey: parsed.incidentKey,
          componentId: parsed.componentId,
          severity: parsed.severity,
          title: parsed.title,
          summary: parsed.summary,
          action: parsed.action ?? null,
          rollbackVersionRef: parsed.rollbackVersionRef ?? null,
          diagnosticMetadata: parsed.diagnosticMetadata,
          openedAt: parsed.openedAt ?? new Date(),
        })
        .onConflictDoNothing({
          target: [incidents.tenantId, incidents.incidentKey],
        })
        .returning();
      if (rows[0]) return mapIncident(rows[0]);
      const [existing] = await tx
        .select()
        .from(incidents)
        .where(
          and(
            eq(incidents.tenantId, parsedTenantId),
            eq(incidents.incidentKey, parsed.incidentKey),
          ),
        )
        .limit(1);
      if (!existing) throw new Error("Incident create returned no row.");
      return mapIncident(existing);
    });
  }

  async getById(tenantId: string, id: string): Promise<IncidentRecord | null> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsedId = z.string().uuid().parse(id);
    return this.withTenant(parsedTenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(incidents)
        .where(
          and(
            eq(incidents.tenantId, parsedTenantId),
            eq(incidents.id, parsedId),
          ),
        )
        .limit(1);
      return row ? mapIncident(row) : null;
    });
  }

  async listRecent(
    tenantId: string,
    limit?: number,
    status?: IncidentStatus,
  ): Promise<IncidentRecord[]> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsedLimit = normalizeLimit(limit);
    const parsedStatus =
      status === undefined ? undefined : incidentStatusSchema.parse(status);
    return this.withTenant(parsedTenantId, async (tx) => {
      const conditions = [eq(incidents.tenantId, parsedTenantId)];
      if (parsedStatus) conditions.push(eq(incidents.status, parsedStatus));
      const rows = await tx
        .select()
        .from(incidents)
        .where(and(...conditions))
        .orderBy(desc(incidents.openedAt))
        .limit(parsedLimit);
      return rows.map(mapIncident);
    });
  }

  async transition(
    tenantId: string,
    id: string,
    fromStatus: IncidentStatus,
    toStatus: IncidentStatus,
    params: TransitionIncidentParams = {},
  ): Promise<IncidentRecord | null> {
    const parsedTenantId = tenantIdSchema.parse(tenantId);
    const parsedId = z.string().uuid().parse(id);
    const parsedParams = transitionIncidentParamsSchema.parse(params);
    assertIncidentTransition(fromStatus, toStatus);
    return this.withTenant(parsedTenantId, async (tx) => {
      const now = new Date();
      const [updated] = await tx
        .update(incidents)
        .set({
          status: toStatus,
          summary:
            parsedParams.summary === undefined
              ? sql`${incidents.summary}`
              : parsedParams.summary,
          action:
            parsedParams.action === undefined
              ? sql`${incidents.action}`
              : parsedParams.action,
          rollbackVersionRef:
            parsedParams.rollbackVersionRef === undefined
              ? sql`${incidents.rollbackVersionRef}`
              : parsedParams.rollbackVersionRef,
          acknowledgedAt:
            toStatus === "acknowledged"
              ? sql`COALESCE(${incidents.acknowledgedAt}, ${now})`
              : sql`${incidents.acknowledgedAt}`,
          resolvedAt:
            toStatus === "resolved" ? now : sql`${incidents.resolvedAt}`,
          updatedAt: now,
        })
        .where(
          and(
            eq(incidents.tenantId, parsedTenantId),
            eq(incidents.id, parsedId),
            eq(incidents.status, fromStatus),
          ),
        )
        .returning();
      return updated ? mapIncident(updated) : null;
    });
  }
}

// ─── Promotion evidence adapter ────────────────────────────────────────────
//
// This is structurally compatible with LearningWorker's PromotionEvidenceProvider
// without making @growthos/db depend on @growthos/core (which would create a
// package cycle). The returned object is intentionally an evaluation *input*;
// `evaluateLearningProposal` remains the single deterministic decision maker.

export interface PromotionEvidenceProposal {
  tenantId: string;
  proposalId: string;
  artifactKind?: string;
  artifactId?: string;
  playbookType?: string;
  verdict?: string;
}

export interface PromotionEvidenceEvaluation {
  proposalId: string;
  risk: ChangeRisk;
  evidenceCount: number;
  uniqueEntities: number;
  confidence: number;
  metricDirection: MetricDirection;
  baselineMetric: number;
  candidateMetric: number;
  worstGuardrailRegression: number;
  humanApproved: boolean;
}

export interface PromotionEvidenceProvider {
  getEvaluation(
    proposal: PromotionEvidenceProposal,
  ): Promise<PromotionEvidenceEvaluation | null>;
}

/**
 * Looks up the persisted proposal and its linked experiment, then aggregates
 * immutable observations. No aggregate can bypass a missing experiment,
 * baseline, candidate, or attribution record.
 */
export class PostgresPromotionEvidenceProvider
  implements PromotionEvidenceProvider
{
  constructor(
    private readonly proposals: LearningProposalRepository,
    private readonly experiments: ExperimentRepository,
    private readonly options: {
      /** A guardrail metric whose upward movement is considered harmful. */
      guardrailMetricName?: string;
    } = {},
  ) {}

  async getEvaluation(
    proposal: PromotionEvidenceProposal,
  ): Promise<PromotionEvidenceEvaluation | null> {
    const tenantId = tenantIdSchema.parse(proposal.tenantId);
    const proposalKey = nonEmptyText.parse(proposal.proposalId);
    const persisted = await this.proposals.getByProposalKey(
      tenantId,
      proposalKey,
    );
    if (!persisted?.experimentId) return null;
    const experiment = await this.experiments.getById(
      tenantId,
      persisted.experimentId,
    );
    if (!experiment) return null;
    const evidence = await this.experiments.summarizeEvidence(
      tenantId,
      experiment.id,
      experiment.metricName,
      this.options.guardrailMetricName,
    );
    if (!evidence) return null;
    return {
      proposalId: proposalKey,
      risk: persisted.risk,
      evidenceCount: evidence.evidenceCount,
      uniqueEntities: evidence.uniqueEntities,
      confidence: evidence.meanAttributionConfidence,
      metricDirection: experiment.metricDirection,
      baselineMetric: evidence.baselineMetric,
      candidateMetric: evidence.candidateMetric,
      worstGuardrailRegression: evidence.worstGuardrailRegression,
      humanApproved: persisted.humanApprovedAt !== null,
    };
  }
}
