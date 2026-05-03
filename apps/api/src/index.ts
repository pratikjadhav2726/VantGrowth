/**
 * GrowthOS API server entrypoint.
 *
 * Bootstraps the OTel SDK **before** any application code loads so that
 * TracerProvider / MeterProvider are registered by the time routes execute.
 * When OTEL_EXPORTER_OTLP_ENDPOINT is unset the SDK runs in no-op mode.
 */
import { initOtelSdk } from "@growthos/observability";

// Must be the first side-effect in the process.
const otel = initOtelSdk({ serviceName: "growthos.api" });

import { serve } from "@hono/node-server";
import { createApp, log } from "./app.js";

const app = createApp();
const port = Number(process.env.PORT ?? 3001);

serve({ fetch: app.fetch, port }, () => {
  log.info({ port }, "@growthos/api listening");
});

process.on("SIGINT", () => {
  otel
    .shutdown()
    .catch(console.error)
    .finally(() => process.exit(0));
});
