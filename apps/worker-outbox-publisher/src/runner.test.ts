import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CycleLeaseGuard } from "./cycle-lease.js";
import type { OutboxPublisher } from "./outbox-publisher.js";
import { OutboxPublisherRunner } from "./runner.js";

const tenantId = "11111111-1111-4111-8111-111111111111";

describe("OutboxPublisherRunner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("runs publish cycles on interval and reports success", async () => {
    const publishCycle = vi.fn(async () => ({
      publishedCount: 1,
      publishedByTenant: { [tenantId]: 1 },
    }));
    const onCycleSuccess = vi.fn();
    const runner = new OutboxPublisherRunner(
      { publishCycle } as unknown as OutboxPublisher,
      { tenantIds: [tenantId], batchSizePerTenant: 50, pollIntervalMs: 1000 },
      { onCycleSuccess },
    );

    runner.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(publishCycle).toHaveBeenCalledTimes(1);
    expect(onCycleSuccess).toHaveBeenCalledWith({
      publishedCount: 1,
      publishedByTenant: { [tenantId]: 1 },
    });
  });

  it("does not overlap cycles when previous cycle is still running", async () => {
    const resolveRef: { current: (() => void) | undefined } = {
      current: undefined,
    };
    const publishCycle = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveRef.current = () =>
            resolve({
              publishedCount: 0,
              publishedByTenant: { [tenantId]: 0 },
            });
        }),
    );
    const runner = new OutboxPublisherRunner(
      { publishCycle } as unknown as OutboxPublisher,
      { tenantIds: [tenantId], batchSizePerTenant: 50, pollIntervalMs: 1000 },
    );

    runner.start();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(publishCycle).toHaveBeenCalledTimes(1);

    const releaseCycle = resolveRef.current;
    if (!releaseCycle) {
      throw new Error("Expected publish cycle resolver to be assigned");
    }
    releaseCycle();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);

    expect(publishCycle).toHaveBeenCalledTimes(2);
  });

  it("reports cycle errors and keeps loop alive", async () => {
    const onCycleError = vi.fn();
    const publishCycle = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({
        publishedCount: 0,
        publishedByTenant: { [tenantId]: 0 },
      });
    const runner = new OutboxPublisherRunner(
      { publishCycle } as unknown as OutboxPublisher,
      { tenantIds: [tenantId], batchSizePerTenant: 50, pollIntervalMs: 1000 },
      { onCycleError },
    );

    runner.start();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(onCycleError).toHaveBeenCalledTimes(1);
    expect(publishCycle).toHaveBeenCalledTimes(2);
  });

  it("skips publish when lease is not acquired", async () => {
    const publishCycle = vi.fn(async () => ({
      publishedCount: 1,
      publishedByTenant: { [tenantId]: 1 },
    }));
    const leaseGuard: CycleLeaseGuard = {
      runWithLease: async () => null,
    };
    const onCycleSuccess = vi.fn();
    const runner = new OutboxPublisherRunner(
      { publishCycle } as unknown as OutboxPublisher,
      { tenantIds: [tenantId], batchSizePerTenant: 50, pollIntervalMs: 1000 },
      { onCycleSuccess, leaseGuard },
    );

    await runner.runCycle();

    expect(publishCycle).toHaveBeenCalledTimes(0);
    expect(onCycleSuccess).not.toHaveBeenCalled();
  });
});
