import { describe, expect, it, vi } from "vitest";
import type {
  PaperclipClientPort,
  PaperclipIssueListItem,
} from "@growthos/adapter";
import { configFromEnv } from "./config.js";
import {
  type DispatchContext,
  PaperclipHeartbeatWorker,
} from "./paperclip-heartbeat-worker.js";

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const baseEnv = {
  PAPERCLIP_BASE_URL: "http://paperclip:3100",
  PAPERCLIP_SERVICE_TOKEN: "svc",
  PAPERCLIP_HEARTBEAT_COMPANY_IDS: "cmp_1",
};

const issue = (
  over: Partial<PaperclipIssueListItem> = {},
): PaperclipIssueListItem => ({
  id: "iss_1",
  identifier: "ACME-1",
  title: "Do work",
  status: "todo",
  assigneeAgentId: "agt_1",
  ...over,
});

function makeClient(
  issues: PaperclipIssueListItem[],
): PaperclipClientPort & {
  checkoutIssue: ReturnType<typeof vi.fn>;
  listCompanyIssues: ReturnType<typeof vi.fn>;
} {
  return {
    createCompany: vi.fn(),
    createAgent: vi.fn(),
    createAgentHire: vi.fn(),
    createIssue: vi.fn(),
    listCompanyIssues: vi.fn(async () => issues),
    checkoutIssue: vi.fn(async () => ({
      id: "iss_1",
      identifier: "ACME-1",
      title: "Do work",
      status: "in_progress",
    })),
    releaseIssue: vi.fn(async () => undefined),
    wakeupAgent: vi.fn(async () => undefined),
    // biome-ignore lint/suspicious/noExplicitAny: test double
  } as any;
}

describe("PaperclipHeartbeatWorker", () => {
  it("dry-run does not mutate Paperclip", async () => {
    const client = makeClient([issue()]);
    const worker = new PaperclipHeartbeatWorker({
      client,
      config: configFromEnv(baseEnv),
      logger: silentLogger,
    });

    await worker.tick();

    expect(client.listCompanyIssues).toHaveBeenCalledWith("cmp_1");
    expect(client.checkoutIssue).not.toHaveBeenCalled();
  });

  it("checks out and dispatches runnable issues when dry-run is off", async () => {
    const client = makeClient([
      issue({ id: "runnable", status: "todo", assigneeAgentId: "agt_1" }),
      issue({ id: "unassigned", assigneeAgentId: null }),
      issue({ id: "done", status: "done", assigneeAgentId: "agt_1" }),
    ]);
    const dispatched: DispatchContext[] = [];
    const worker = new PaperclipHeartbeatWorker({
      client,
      config: configFromEnv({ ...baseEnv, PAPERCLIP_HEARTBEAT_DRY_RUN: "false" }),
      logger: silentLogger,
      dispatch: async (ctx) => {
        dispatched.push(ctx);
      },
      newRunId: () => "run_1",
    });

    await worker.tick();

    // Only the assigned + runnable-status issue is processed.
    expect(client.checkoutIssue).toHaveBeenCalledTimes(1);
    expect(client.checkoutIssue).toHaveBeenCalledWith({
      issueId: "runnable",
      agentId: "agt_1",
      runId: "run_1",
    });
    expect(dispatched).toEqual([
      expect.objectContaining({ issueId: "runnable", agentId: "agt_1", runId: "run_1" }),
    ]);
  });

  it("releases the issue if dispatch fails", async () => {
    const client = makeClient([issue({ id: "boom" })]);
    const worker = new PaperclipHeartbeatWorker({
      client,
      config: configFromEnv({ ...baseEnv, PAPERCLIP_HEARTBEAT_DRY_RUN: "false" }),
      logger: silentLogger,
      dispatch: async () => {
        throw new Error("dispatch exploded");
      },
    });

    await worker.tick();

    expect(client.releaseIssue).toHaveBeenCalledWith("boom");
  });
});
