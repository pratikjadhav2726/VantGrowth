/**
 * OpenTelemetry SDK initialiser for GrowthOS Node.js services.
 *
 * Call initOtelSdk() as the very first statement in a service entry point
 * (e.g. apps/api/src/index.ts) so the SDK registers its TracerProvider and
 * MeterProvider before any application code loads.
 *
 * When OTEL_EXPORTER_OTLP_ENDPOINT is not set (local dev without SigNoz),
 * the SDK starts with no exporters -- all traces/metrics are silently
 * discarded and the application behaves normally.
 *
 * Environment variables:
 *   OTEL_SERVICE_NAME           -- overrides config.serviceName (optional)
 *   OTEL_EXPORTER_OTLP_ENDPOINT -- base URL, e.g. http://localhost:4318
 *   OTEL_EXPORTER_OTLP_HEADERS  -- comma-separated key=value auth headers
 *   OTEL_SDK_DISABLED           -- set to "true" to disable entirely
 */
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

export interface OtelSdkConfig {
  /** Logical service name surfaced in SigNoz / Jaeger. */
  serviceName: string;
  /** Semantic version of the service binary. Defaults to "0.1.0". */
  serviceVersion?: string;
  /**
   * OTLP/HTTP base URL, e.g. http://localhost:4318.
   * When absent, falls back to OTEL_EXPORTER_OTLP_ENDPOINT or no-op.
   */
  otlpEndpoint?: string;
  /** Additional HTTP headers sent with every OTLP export request. */
  otlpHeaders?: Record<string, string>;
  /**
   * Metrics export interval in milliseconds. Defaults to 15_000 (15 s).
   */
  metricsIntervalMs?: number;
}

export interface OtelSdkHandle {
  /** Flushes pending spans/metrics and shuts down the SDK gracefully. */
  shutdown(): Promise<void>;
}

/**
 * Initialises the OTel SDK. Must be called before any @opentelemetry/api
 * tracer/meter calls to ensure they are backed by real providers.
 *
 * Registers a SIGTERM handler that gracefully shuts down the SDK so the
 * process does not exit before all pending telemetry is exported.
 */
export const initOtelSdk = (config: OtelSdkConfig): OtelSdkHandle => {
  if (process.env.OTEL_SDK_DISABLED === "true") {
    return { shutdown: () => Promise.resolve() };
  }

  const serviceName = process.env.OTEL_SERVICE_NAME ?? config.serviceName;

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion ?? "0.1.0",
  });

  const endpoint =
    config.otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  const headers: Record<string, string> = {
    ...(config.otlpHeaders ?? {}),
    ...parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
  };

  const sdk = new NodeSDK({
    resource,
    ...(endpoint
      ? {
          traceExporter: new OTLPTraceExporter({
            url: `${endpoint}/v1/traces`,
            headers,
          }),
          metricReader: new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({
              url: `${endpoint}/v1/metrics`,
              headers,
            }),
            exportIntervalMillis: config.metricsIntervalMs ?? 15_000,
          }),
        }
      : {}),
  });

  sdk.start();

  const shutdown = async (): Promise<void> => {
    await sdk.shutdown();
  };

  process.on("SIGTERM", () => {
    shutdown()
      .catch((err: unknown) => console.error("[otel] shutdown error", err))
      .finally(() => process.exit(0));
  });

  return { shutdown };
};

// helpers

const parseOtlpHeaders = (raw: string | undefined): Record<string, string> => {
  if (!raw?.trim()) return {};
  return Object.fromEntries(
    raw
      .split(",")
      .map((pair) => pair.trim().split("=", 2))
      .filter((parts): parts is [string, string] => parts.length === 2),
  );
};
