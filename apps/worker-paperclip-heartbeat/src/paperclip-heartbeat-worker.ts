import { randomUUID } from "node:crypto";
import type {
  PaperclipClientPort,
  PaperclipIssueListItem,
} from "@growthos/adapter";
import type { PaperclipHeartbeatConfig } from "./config.js";

/** Minimal logger surface (matches @growthos/observability createLogger). */
export interface WorkerLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

/**
 * A dispatched unit of work: a Paperclip issue that has been checked out to a
 * GrowthOS-native agent and is ready to be executed by a domain worker.
 */
export interface DispatchContext {
  /** GrowthOS tenant that explicitly owns this Paperclip company. */
  tenantId: string;
  companyId: string;
  agentId: string;
  issueId: string;
  issueIdentifier?: string | null;
  title?: string | null;
  runId: string;
}

/**
 * Routes a checked-out issue to the GrowthOS execution path. Production wiring
 * persists a tenant-scoped `paperclip.work.ready.v1` outbox event, which the
 * outbox publisher forwards to NATS.
 */
export type Dispatcher = (ctx: DispatchContext) => Promise<void>;

export interface PaperclipHeartbeatWorkerDeps {
  client: PaperclipClientPort;
  config: PaperclipHeartbeatConfig;
  logger: WorkerLogger;
  dispatch?: Dispatcher;
  /** Injectable for tests. */
  newRunId?: () => string;
}

export class PaperclipHeartbeatWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private readonly dispatch: Dispatcher;
  private readonly newRunId: () => string;

  constructor(private readonly deps: PaperclipHeartbeatWorkerDeps) {
    this.dispatch =
      deps.dispatch ??
      (async () => {
        // Never claim work and silently drop it. The executable bootstrap
        // wires OutboxPaperclipWorkDispatcher; direct construction without it
        // fails closed and requeues only an issue this worker actually claimed.
        throw new Error(
          "Paperclip heartbeat dispatcher is not configured; refusing to drop checked-out work.",
        );
      });
    this.newRunId = deps.newRunId ?? (() => randomUUID());
  }

  start(): void {
    const { pollIntervalMs, companyIds, companyTenantMap, dryRun } =
      this.deps.config;
    this.deps.logger.info(
      {
        companyIds,
        mappedCompanyIds: Object.keys(companyTenantMap),
        pollIntervalMs,
        dryRun,
      },
      "paperclip-heartbeat worker starting",
    );
    // Fire once immediately, then on the interval.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One poll cycle across all configured companies. Never throws. */
  async tick(): Promise<void> {
    if (this.ticking) return; // avoid overlapping polls
    this.ticking = true;
    try {
      for (const companyId of this.deps.config.companyIds) {
        try {
          await this.tickCompany(companyId);
        } catch (err) {
          // One unavailable Paperclip company must not prevent independent
          // tenants from receiving their next heartbeat.
          this.deps.logger.error(
            {
              companyId,
              err: err instanceof Error ? err.message : String(err),
            },
            "paperclip-heartbeat company poll failed",
          );
        }
      }
    } catch (err) {
      this.deps.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "paperclip-heartbeat tick failed",
      );
    } finally {
      this.ticking = false;
    }
  }

  private async tickCompany(companyId: string): Promise<void> {
    const tenantId = this.deps.config.companyTenantMap[companyId];
    if (!tenantId && !this.deps.config.dryRun) {
      // configFromEnv rejects this at startup. Retain a runtime guard for
      // programmatic construction so a bad deployment cannot claim work for
      // an unknown tenant.
      this.deps.logger.error(
        { companyId },
        "Paperclip company has no GrowthOS tenant mapping; refusing live dispatch",
      );
      return;
    }

    const issues = await this.deps.client.listCompanyIssues(companyId);
    const runnable = issues.filter((issue) => this.isRunnable(issue));
    if (runnable.length === 0) return;

    this.deps.logger.info(
      { companyId, runnable: runnable.length },
      "found runnable issues",
    );

    for (const issue of runnable) {
      // The list endpoint is company-scoped, but reject a malformed/cross-
      // company row before it can cross a tenant boundary.
      if (issue.companyId && issue.companyId !== companyId) {
        this.deps.logger.error(
          {
            companyId,
            issueId: issue.id,
            issueCompanyId: issue.companyId,
          },
          "Paperclip returned issue with mismatched company; refusing dispatch",
        );
        continue;
      }

      await this.processIssue(companyId, tenantId, issue);
    }
  }

  private isRunnable(issue: PaperclipIssueListItem): boolean {
    return (
      typeof issue.assigneeAgentId === "string" &&
      issue.assigneeAgentId.length > 0 &&
      this.deps.config.runnableStatuses.includes(issue.status)
    );
  }

  private async processIssue(
    companyId: string,
    tenantId: string | undefined,
    issue: PaperclipIssueListItem,
  ): Promise<void> {
    const agentId = issue.assigneeAgentId as string;
    const runId = this.newRunId();
    const base = {
      companyId,
      agentId,
      issueId: issue.id,
      issueIdentifier: issue.identifier ?? null,
      title: issue.title ?? null,
      runId,
    };

    if (this.deps.config.dryRun) {
      this.deps.logger.info(
        base,
        "[dry-run] would check out and dispatch issue",
      );
      return;
    }

    if (!tenantId) {
      // Defensive backstop for callers that construct a config without going
      // through configFromEnv. Crucially, this happens before checkout.
      this.deps.logger.error(
        base,
        "Paperclip issue has no resolved GrowthOS tenant; refusing checkout",
      );
      return;
    }

    const context: DispatchContext = { ...base, tenantId };
    let checkedOut = false;

    try {
      // Claim the issue in Paperclip (status -> in_progress, locked to runId).
      await this.deps.client.checkoutIssue({
        issueId: issue.id,
        agentId,
        // Prevent a stale list response from claiming an issue whose status
        // changed to something this worker is not allowed to execute.
        expectedStatuses: this.deps.config.runnableStatuses,
        runId,
      });
      checkedOut = true;

      await this.dispatch(context);
      this.deps.logger.info(context, "Paperclip issue dispatched to GrowthOS");
    } catch (err) {
      this.deps.logger.error(
        { ...context, err: err instanceof Error ? err.message : String(err) },
        checkedOut
          ? "failed to dispatch checked-out Paperclip issue"
          : "failed to check out Paperclip issue",
      );

      // Do not requeue after a failed checkout: that could mutate work claimed
      // by another worker. Once this worker has claimed it, a tenant-safe
      // requeue is the best-effort recovery path after an outbox fault. Unlike
      // Paperclip's generic release endpoint, requeue keeps the assignee so the
      // next poll can retry the issue.
      if (!checkedOut) return;

      try {
        await this.deps.client.requeueIssue(issue.id);
      } catch (requeueErr) {
        this.deps.logger.error(
          {
            ...context,
            err:
              requeueErr instanceof Error
                ? requeueErr.message
                : String(requeueErr),
          },
          "failed to requeue Paperclip issue after dispatch failure",
        );
      }
    }
  }
}
