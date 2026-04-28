/**
 * @growthos/observability — OpenTelemetry + structured logging for GrowthOS.
 *
 * Exports:
 *   - `getTracer(name)`         — OTel Tracer from global provider
 *   - `getMeter(name)`          — OTel Meter from global provider
 *   - `createStandardMetrics()` — rate / duration / error counter bundle
 *   - `createLogger(service)`   — pino structured logger factory
 *   - `initOtelSdk(config)`     — SDK bootstrap (call in entrypoint only)
 *   - `createHttpMiddleware()`  — Hono per-request span + metrics middleware
 *
 * Principle 1.5 contract: every module that imports this package gets OTel
 * spans, standard metrics, and structured logs with zero boilerplate.
 */

export { getTracer, type Tracer } from "./tracer.js";

export {
  getMeter,
  createStandardMetrics,
  type Counter,
  type Histogram,
  type Meter,
  type StandardMetrics,
} from "./meter.js";

export { createLogger, type LogContext, type LoggerOptions } from "./logger.js";

export { initOtelSdk, type OtelSdkConfig, type OtelSdkHandle } from "./sdk.js";

export { createHttpMiddleware } from "./middleware.js";
