/**
 * OpenTelemetry Meter API helpers.
 *
 * Returns the meter for `name` from the globally registered MeterProvider.
 * Falls back to a no-op meter when no SDK is initialised.
 *
 * Standard three-metric contract (Principle 1.5):
 *   - requests.total    — counter (rate)
 *   - requests.duration — histogram (latency)
 *   - requests.errors   — counter (error rate)
 */
import {
  type Counter,
  type Histogram,
  type Meter,
  metrics,
} from "@opentelemetry/api";

export type { Counter, Histogram, Meter } from "@opentelemetry/api";

export const getMeter = (name: string, version = "0.1.0"): Meter =>
  metrics.getMeter(name, version);

export interface StandardMetrics {
  /** Incremented on every handled request. */
  requestsTotal: Counter;
  /** Records end-to-end handler duration in milliseconds. */
  requestsDurationMs: Histogram;
  /** Incremented on every request that results in an error (≥ 400). */
  requestsErrors: Counter;
}

/**
 * Creates the three canonical metrics for a service or sub-system.
 *
 * @param meter  — meter returned by `getMeter()`
 * @param prefix — dot-separated prefix, e.g. `"growthos.api"`
 */
export const createStandardMetrics = (
  meter: Meter,
  prefix: string,
): StandardMetrics => ({
  requestsTotal: meter.createCounter(`${prefix}.requests.total`, {
    description: "Total handled requests",
    unit: "{request}",
  }),
  requestsDurationMs: meter.createHistogram(`${prefix}.requests.duration_ms`, {
    description: "Request duration in milliseconds",
    unit: "ms",
  }),
  requestsErrors: meter.createCounter(`${prefix}.requests.errors.total`, {
    description:
      "Total requests that resulted in an error response (HTTP ≥ 400)",
    unit: "{request}",
  }),
});
