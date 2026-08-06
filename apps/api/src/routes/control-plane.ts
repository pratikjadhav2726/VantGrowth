/**
 * /v1/control-plane — tenant-scoped operational state for the founder
 * command center.
 *
 * This route deliberately separates an empty result from an unavailable
 * store. An empty incident list means the configured incident store has no
 * incidents; a 503 means the API cannot make that assertion.
 *
 * Routes:
 *   GET /v1/control-plane/summary
 *   GET /v1/control-plane/health
 *   GET /v1/control-plane/incidents
 */

import type {
  ApprovalFeedbackRepository,
  MotionStackRepository,
  OutboxRepository,
  SignalEventsRepository,
} from "@growthos/db";
import { tenantIdSchema } from "@growthos/db";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { ServiceUnavailableError } from "../http-errors.js";

const CONTROL_PLANE_LIST_LIMIT = 100;
const OUTBOX_SCAN_LIMIT = 500;
const APPROVAL_DECISION_SCAN_LIMIT = 1_000;

const approvalEventTypes = new Set([
  "blog_draft.v1",
  "content_brief.v1",
  "intel_brief.v1",
]);

const approvalIssueIdKeys = [
  "issueId",
  "issue_id",
  "draft_id",
  "draftId",
  "brief_id",
  "briefId",
  "content_id",
  "contentId",
] as const;

export const componentHealthStateSchema = z.enum([
  "healthy",
  "degraded",
  "recovering",
  "quarantined",
]);

export type ComponentHealthState = z.infer<typeof componentHealthStateSchema>;

/**
 * Read model intentionally excludes raw connector payloads, evidence bundles,
 * and stack traces. Those belong in the protected incident/audit stores, not a
 * broadly consumed dashboard endpoint.
 */
export interface ComponentHealthControlPlaneRecord {
  componentId: string;
  state: ComponentHealthState;
  action: string;
  allowExternalActions: boolean;
  reasons: string[];
  observedAt: Date;
}

export interface ComponentHealthControlPlaneRepository {
  listLatest(
    tenantId: string,
    limit: number,
  ): Promise<ComponentHealthControlPlaneRecord[]>;
}

export interface IncidentControlPlaneRecord {
  id: string;
  componentId: string;
  severity: "low" | "medium" | "high" | "critical";
  status: string;
  title: string;
  summary: string;
  openedAt: Date;
  resolvedAt: Date | null;
}

export interface IncidentControlPlaneRepository {
  listRecent(
    tenantId: string,
    limit: number,
  ): Promise<IncidentControlPlaneRecord[]>;
}

export interface ControlPlaneStatusSummary {
  total: number;
  byStatus: Record<string, number>;
}

export interface ExperimentControlPlaneRepository {
  getSummary(tenantId: string): Promise<ControlPlaneStatusSummary>;
}

export interface LearningProposalControlPlaneRepository {
  getSummary(tenantId: string): Promise<ControlPlaneStatusSummary>;
}

export interface ControlPlaneRouteDependencies {
  outboxRepository: OutboxRepository | null;
  signalEventsRepository: SignalEventsRepository | null;
  approvalFeedbackRepository: ApprovalFeedbackRepository | null;
  motionStackRepository: MotionStackRepository | null;
  componentHealthRepository: ComponentHealthControlPlaneRepository | null;
  incidentRepository: IncidentControlPlaneRepository | null;
  experimentRepository: ExperimentControlPlaneRepository | null;
  learningProposalRepository: LearningProposalControlPlaneRepository | null;
}

type DataSourceStatus = "available" | "not_configured" | "unavailable";

interface LoadedSource<T> {
  status: DataSourceStatus;
  value: T;
}

const loadOptional = async <TRepository, T>(
  repository: TRepository | null,
  fallback: T,
  load: (configuredRepository: TRepository) => Promise<T>,
): Promise<LoadedSource<T>> => {
  if (!repository) return { status: "not_configured", value: fallback };

  try {
    return { status: "available", value: await load(repository) };
  } catch {
    // The response marks the section unavailable rather than presenting a
    // failed read as a zero. This prevents unsafe automation from treating
    // missing operational evidence as a healthy state.
    return { status: "unavailable", value: fallback };
  }
};

const requireTenantId = (
  c: Context,
): { tenantId: string } | { response: Response } => {
  const value = c.req.header("X-Tenant-Id");
  if (!value) {
    return {
      response: c.json({ error: "X-Tenant-Id header is required" }, 400),
    };
  }

  const parsed = tenantIdSchema.safeParse(value);
  if (!parsed.success) {
    return {
      response: c.json({ error: "X-Tenant-Id must be a valid UUID" }, 400),
    };
  }

  return { tenantId: parsed.data };
};

const parseLimit = (
  value: string | undefined,
  defaultValue: number,
  max: number,
): number | null => {
  if (value === undefined) return defaultValue;
  const parsed = z.coerce.number().int().min(1).max(max).safeParse(value);
  return parsed.success ? parsed.data : null;
};

const startOfUtcDay = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

const extractApprovalIssueId = (
  payload: Record<string, unknown>,
): string | null => {
  for (const key of approvalIssueIdKeys) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
};

const isOpenIncident = (status: string): boolean =>
  !["resolved", "closed", "cancelled"].includes(status.toLowerCase());

const toPublicHealthItem = (record: ComponentHealthControlPlaneRecord) => ({
  componentId: record.componentId,
  state: record.state,
  action: record.action,
  allowExternalActions: record.allowExternalActions,
  reasons: record.reasons,
  observedAt: record.observedAt.toISOString(),
});

const toPublicIncidentItem = (record: IncidentControlPlaneRecord) => ({
  id: record.id,
  componentId: record.componentId,
  severity: record.severity,
  status: record.status,
  title: record.title,
  summary: record.summary,
  openedAt: record.openedAt.toISOString(),
  resolvedAt: record.resolvedAt?.toISOString() ?? null,
});

const getOverallHealth = (
  items: ComponentHealthControlPlaneRecord[],
): "healthy" | "degraded" | "recovering" | "quarantined" | "unknown" => {
  if (items.length === 0) return "unknown";
  if (items.some((item) => item.state === "quarantined")) {
    return "quarantined";
  }
  if (items.some((item) => item.state === "recovering")) {
    return "recovering";
  }
  if (items.some((item) => item.state === "degraded")) return "degraded";
  return "healthy";
};

/**
 * Founder-safe control-plane read routes. All repository calls are explicitly
 * tenant-scoped; no route accepts a tenant identifier in the body or path.
 */
export const createControlPlaneRoutes = (
  deps: ControlPlaneRouteDependencies,
): Hono => {
  const route = new Hono();

  route.get("/summary", async (c) => {
    c.header("Cache-Control", "private, no-store");
    const tenant = requireTenantId(c);
    if ("response" in tenant) return tenant.response;

    const hasAnyConfiguredStore = [
      deps.outboxRepository,
      deps.signalEventsRepository,
      deps.approvalFeedbackRepository,
      deps.motionStackRepository,
      deps.componentHealthRepository,
      deps.incidentRepository,
      deps.experimentRepository,
      deps.learningProposalRepository,
    ].some((repository) => repository !== null);

    if (!hasAnyConfiguredStore) {
      throw new ServiceUnavailableError(
        "Control-plane stores are not configured. Set DATABASE_URL.",
      );
    }

    const now = new Date();
    const today = startOfUtcDay(now);
    const lastSevenDays = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000);

    const [
      signals,
      outbox,
      decisions,
      motion,
      componentHealth,
      incidents,
      experiments,
      learningProposals,
    ] = await Promise.all([
      loadOptional(deps.signalEventsRepository, 0, (repository) =>
        repository.countSince(tenant.tenantId, today),
      ),
      loadOptional(deps.outboxRepository, [], (repository) =>
        repository.listUnconsumed(tenant.tenantId, OUTBOX_SCAN_LIMIT),
      ),
      loadOptional(deps.approvalFeedbackRepository, [], (repository) =>
        repository.listRecent(tenant.tenantId, APPROVAL_DECISION_SCAN_LIMIT),
      ),
      loadOptional(deps.motionStackRepository, null, (repository) =>
        repository.getOverview(tenant.tenantId, 1),
      ),
      loadOptional(deps.componentHealthRepository, [], (repository) =>
        repository.listLatest(tenant.tenantId, CONTROL_PLANE_LIST_LIMIT),
      ),
      loadOptional(deps.incidentRepository, [], (repository) =>
        repository.listRecent(tenant.tenantId, CONTROL_PLANE_LIST_LIMIT),
      ),
      loadOptional(
        deps.experimentRepository,
        { total: 0, byStatus: {} },
        (repository) => repository.getSummary(tenant.tenantId),
      ),
      loadOptional(
        deps.learningProposalRepository,
        { total: 0, byStatus: {} },
        (repository) => repository.getSummary(tenant.tenantId),
      ),
    ]);

    const dataSources = {
      signals: signals.status,
      outbox: outbox.status,
      approvals: decisions.status,
      motion: motion.status,
      componentHealth: componentHealth.status,
      incidents: incidents.status,
      experiments: experiments.status,
      learningProposals: learningProposals.status,
    } as const;

    if (!Object.values(dataSources).includes("available")) {
      throw new ServiceUnavailableError(
        "Configured control-plane stores are unavailable.",
      );
    }

    const decidedIssueIds = new Set(
      decisions.value.map(
        (decision) => `${decision.outputType}:${decision.issueId}`,
      ),
    );
    const pendingApprovals = outbox.value.filter((event) => {
      if (!approvalEventTypes.has(event.eventType)) return false;
      const issueId = extractApprovalIssueId(event.payload);
      return (
        issueId === null ||
        !decidedIssueIds.has(`${event.eventType}:${issueId}`)
      );
    });
    const recentDecisions = decisions.value.filter(
      (decision) => decision.createdAt.getTime() >= lastSevenDays.getTime(),
    );
    const approvedLastSevenDays = recentDecisions.filter(
      (decision) =>
        decision.action === "approved" ||
        decision.action === "edited_then_approved" ||
        decision.action === "auto_approved",
    ).length;
    const rejectedLastSevenDays = recentDecisions.filter(
      (decision) => decision.action === "rejected",
    ).length;
    const openIncidents = incidents.value.filter((incident) =>
      isOpenIncident(incident.status),
    );
    const overallHealth = getOverallHealth(componentHealth.value);

    return c.json({
      tenantId: tenant.tenantId,
      generatedAt: now.toISOString(),
      partial: Object.values(dataSources).some(
        (status) => status !== "available",
      ),
      dataSources,
      signals: {
        today: signals.value,
        windowStart: today.toISOString(),
      },
      approvals: {
        pending: pendingApprovals.length,
        pendingIsLowerBound: outbox.value.length === OUTBOX_SCAN_LIMIT,
        decisionScanTruncated:
          decisions.value.length === APPROVAL_DECISION_SCAN_LIMIT,
        approvedLastSevenDays,
        rejectedLastSevenDays,
      },
      execution: {
        pendingOutboxEvents: outbox.value.length,
        pendingOutboxEventsIsLowerBound:
          outbox.value.length === OUTBOX_SCAN_LIMIT,
      },
      motion: {
        primaryMotions: motion.value?.latestStack?.primaryMotions ?? [],
        secondaryMotions: motion.value?.latestStack?.secondaryMotions ?? [],
        scorerVersion: motion.value?.latestScore?.scorerVersion ?? null,
        scoredAt: motion.value?.latestScore?.scoredAt.toISOString() ?? null,
      },
      health: {
        overall: overallHealth,
        overallMayBeIncomplete:
          componentHealth.value.length === CONTROL_PLANE_LIST_LIMIT,
        components: componentHealth.value.length,
        componentsIsLowerBound:
          componentHealth.value.length === CONTROL_PLANE_LIST_LIMIT,
        degraded: componentHealth.value.filter(
          (component) => component.state === "degraded",
        ).length,
        recovering: componentHealth.value.filter(
          (component) => component.state === "recovering",
        ).length,
        quarantined: componentHealth.value.filter(
          (component) => component.state === "quarantined",
        ).length,
        externalActionsBlocked: componentHealth.value.filter(
          (component) => !component.allowExternalActions,
        ).length,
      },
      incidents: {
        open: openIncidents.length,
        openIsLowerBound: incidents.value.length === CONTROL_PLANE_LIST_LIMIT,
        criticalOpen: openIncidents.filter(
          (incident) => incident.severity === "critical",
        ).length,
        criticalOpenIsLowerBound:
          incidents.value.length === CONTROL_PLANE_LIST_LIMIT,
      },
      experiments: {
        total: experiments.value.total,
        running: experiments.value.byStatus.running ?? 0,
        paused: experiments.value.byStatus.paused ?? 0,
        concluded: experiments.value.byStatus.concluded ?? 0,
        promoted: experiments.value.byStatus.promoted ?? 0,
        rolledBack: experiments.value.byStatus.rolled_back ?? 0,
      },
      learning: {
        total: learningProposals.value.total,
        awaitingEvidence:
          learningProposals.value.byStatus.awaiting_evidence ?? 0,
        evaluating: learningProposals.value.byStatus.evaluating ?? 0,
        requiresApproval:
          learningProposals.value.byStatus.requires_approval ?? 0,
        promoted: learningProposals.value.byStatus.promoted ?? 0,
        rolledBack: learningProposals.value.byStatus.rolled_back ?? 0,
      },
    });
  });

  route.get("/health", async (c) => {
    c.header("Cache-Control", "private, no-store");
    const tenant = requireTenantId(c);
    if ("response" in tenant) return tenant.response;

    if (!deps.componentHealthRepository) {
      throw new ServiceUnavailableError(
        "Component health store is not configured. Set DATABASE_URL.",
      );
    }

    const limit = parseLimit(
      c.req.query("limit"),
      CONTROL_PLANE_LIST_LIMIT,
      CONTROL_PLANE_LIST_LIMIT,
    );
    if (limit === null) {
      return c.json(
        {
          error: `limit must be an integer between 1 and ${CONTROL_PLANE_LIST_LIMIT}`,
        },
        400,
      );
    }

    let components: ComponentHealthControlPlaneRecord[];
    try {
      components = await deps.componentHealthRepository.listLatest(
        tenant.tenantId,
        limit,
      );
    } catch {
      throw new ServiceUnavailableError(
        "Component health store is unavailable.",
      );
    }

    return c.json({
      tenantId: tenant.tenantId,
      generatedAt: new Date().toISOString(),
      overall: getOverallHealth(components),
      items: components.map(toPublicHealthItem),
      total: components.length,
      totalIsLowerBound: components.length === limit,
    });
  });

  route.get("/incidents", async (c) => {
    c.header("Cache-Control", "private, no-store");
    const tenant = requireTenantId(c);
    if ("response" in tenant) return tenant.response;

    if (!deps.incidentRepository) {
      throw new ServiceUnavailableError(
        "Incident store is not configured. Set DATABASE_URL.",
      );
    }

    const limit = parseLimit(
      c.req.query("limit"),
      50,
      CONTROL_PLANE_LIST_LIMIT,
    );
    if (limit === null) {
      return c.json(
        {
          error: `limit must be an integer between 1 and ${CONTROL_PLANE_LIST_LIMIT}`,
        },
        400,
      );
    }

    let incidents: IncidentControlPlaneRecord[];
    try {
      incidents = await deps.incidentRepository.listRecent(
        tenant.tenantId,
        limit,
      );
    } catch {
      throw new ServiceUnavailableError("Incident store is unavailable.");
    }

    return c.json({
      tenantId: tenant.tenantId,
      generatedAt: new Date().toISOString(),
      items: incidents.map(toPublicIncidentItem),
      total: incidents.length,
      totalIsLowerBound: incidents.length === limit,
      open: incidents.filter((incident) => isOpenIncident(incident.status))
        .length,
    });
  });

  return route;
};
