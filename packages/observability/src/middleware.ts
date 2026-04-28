/**
 * Hono middleware that wraps each HTTP request in an OTel span and records
 * the three canonical metrics (rate, duration, errors).
 *
 * Complies with Engineering Principle 1.5: "Every new module ships with OTel
 * spans on its public boundary, structured logs with tenant_id/run_id/agent_id,
 * three Prometheus metrics minimum."
 *
 * Usage (apps/api/src/app.ts):
 *
 *   import { createHttpMiddleware, getTracer, getMeter } from "@growthos/observability";
 *   app.use(createHttpMiddleware(getTracer("growthos.api"), getMeter("growthos.api")));
 */
import {
  type Meter,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  context,
  trace,
} from "@opentelemetry/api";
import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_URL_FULL,
} from "@opentelemetry/semantic-conventions";
import type { Context, MiddlewareHandler, Next } from "hono";

import { createStandardMetrics } from "./meter.js";

/**
 * Returns a Hono middleware handler that:
 * 1. Starts a SERVER-kind span for every request, propagating W3C traceparent
 *    headers from upstream callers.
 * 2. Records `http.method`, `http.route`, `http.response.status_code`.
 * 3. Sets span status ERROR for HTTP 5xx; records exception for uncaught throws.
 * 4. Increments the three standard metrics with `http.method` + `http.route`
 *    dimensions.
 */
export const createHttpMiddleware = (
  tracer: Tracer,
  meter: Meter,
): MiddlewareHandler => {
  const metrics = createStandardMetrics(meter, "growthos.api");

  return async (c: Context, next: Next): Promise<void> => {
    const method = c.req.method;
    // routePath is the matched route pattern (e.g. /v1/commands/outbox),
    // falling back to the raw path for unmatched requests.
    const route = (c.req as { routePath?: string }).routePath ?? c.req.path;

    const span = tracer.startSpan(`${method} ${route}`, {
      kind: SpanKind.SERVER,
      attributes: {
        [ATTR_HTTP_REQUEST_METHOD]: method,
        [ATTR_HTTP_ROUTE]: route,
        [ATTR_URL_FULL]: c.req.url,
      },
    });

    const startMs = Date.now();

    try {
      await context.with(trace.setSpan(context.active(), span), () => next());

      const status = c.res.status;
      span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, status);

      if (status >= 500) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        metrics.requestsErrors.add(1, {
          "http.method": method,
          "http.route": route,
          "error.type": "server_error",
        });
      } else if (status >= 400) {
        metrics.requestsErrors.add(1, {
          "http.method": method,
          "http.route": route,
          "error.type": "client_error",
        });
      }
    } catch (err: unknown) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      metrics.requestsErrors.add(1, {
        "http.method": method,
        "http.route": route,
        "error.type": "exception",
      });
      throw err;
    } finally {
      const durationMs = Date.now() - startMs;
      span.end();

      metrics.requestsTotal.add(1, {
        "http.method": method,
        "http.route": route,
      });
      metrics.requestsDurationMs.record(durationMs, {
        "http.method": method,
        "http.route": route,
      });
    }
  };
};
