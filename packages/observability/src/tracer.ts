/**
 * Thin wrapper around the OpenTelemetry Tracer API.
 *
 * Returns the tracer for `name` from the globally registered TracerProvider.
 * When no SDK is initialised (unit tests, local dev without OTLP) the OTel
 * API automatically returns a no-op tracer, so call-sites never need to
 * guard against a null value.
 */
import { type Tracer, trace } from "@opentelemetry/api";

export type { Tracer } from "@opentelemetry/api";

export const getTracer = (name: string, version = "0.1.0"): Tracer =>
  trace.getTracer(name, version);
