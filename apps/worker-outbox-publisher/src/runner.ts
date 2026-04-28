import type {
  OutboxPublisher,
  OutboxPublisherRuntimeConfig,
  PublishCycleResult,
} from "./outbox-publisher.js";

export interface OutboxPublisherRunnerOptions {
  onCycleSuccess?: (result: PublishCycleResult) => void;
  onCycleError?: (error: unknown) => void;
  leaseGuard?: {
    runWithLease<T>(operation: () => Promise<T>): Promise<T | null>;
  };
}

export class OutboxPublisherRunner {
  private timer: NodeJS.Timeout | null = null;
  private cycleInFlight = false;

  constructor(
    private readonly publisher: OutboxPublisher,
    private readonly runtimeConfig: OutboxPublisherRuntimeConfig,
    private readonly options: OutboxPublisherRunnerOptions = {},
  ) {}

  start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      void this.runCycle();
    }, this.runtimeConfig.pollIntervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async runCycle(): Promise<void> {
    if (this.cycleInFlight) return;
    this.cycleInFlight = true;

    try {
      const operation = () =>
        this.publisher.publishCycle(
          this.runtimeConfig.tenantIds,
          this.runtimeConfig.batchSizePerTenant,
        );
      const result = this.options.leaseGuard
        ? await this.options.leaseGuard.runWithLease(operation)
        : await operation();
      if (!result) return;
      this.options.onCycleSuccess?.(result);
    } catch (error) {
      this.options.onCycleError?.(error);
    } finally {
      this.cycleInFlight = false;
    }
  }
}
