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
  companyId: string;
  agentId: string;
  issueId: string;
  issueIdentifier?: string | null;
  title?: string | null;
  runId: string;
}

/**
 * Routes a checked-out issue to the GrowthOS execution path. The real
 * implementation should map the issue to a motion / domain worker (e.g. publish
 * a NATS event on `t.<tenant>.paperclip.work.ready` or enqueue via the outbox),
 * then report completion back to Paperclip.
 *
 * The default dispatcher just logs — this is the seam left for the domain wiring.
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
      (async (ctx) => {
        this.deps.logger.info(
          ctx,
          "[dispatch stub] issue ready for GrowthOS execution — wire domain routing here",
        );
      });
    this.newRunId = deps.newRunId ?? (() => randomUUID());
  }

  start(): void {
    const { pollIntervalMs, companyIds, dryRun } = this.deps.config;
    this.deps.logger.info(
      { companyIds, pollIntervalMs, dryRun },
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
        await this.tickCompany(companyId);
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
    const issues = await this.deps.client.listCompanyIssues(companyId);
    const runnable = issues.filter((issue) => this.isRunnable(issue));
    if (runnable.length === 0) return;

    this.deps.logger.info(
      { companyId, runnable: runnable.length },
      "found runnable issues",
    );

    for (const issue of runnable) {
      await this.processIssue(companyId, issue);
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

    try {
      // Claim the issue in Paperclip (status -> in_progress, locked to runId).
      await this.deps.client.checkoutIssue({
        issueId: issue.id,
        agentId,
        runId,
      });
      await this.dispatch(base);
    } catch (err) {
      this.deps.logger.error(
        { ...base, err: err instanceof Error ? err.message : String(err) },
        "failed to check out / dispatch issue — releasing",
      );
      // Best-effort release so the issue is not left locked to a dead run.
      await this.deps.client.releaseIssue(issue.id).catch(() => undefined);
    }
  }
}
