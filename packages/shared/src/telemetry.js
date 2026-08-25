/**
 * OpenTelemetry bootstrap. Preloaded before application code via
 *   NODE_OPTIONS=--import @ecom/shared/telemetry
 * so the auto-instrumentations patch http/express/pg/redis/elasticsearch before
 * those modules are first imported.
 *
 * It is a no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set, so local runs, tests,
 * and Compose without a collector are completely unaffected: the app behaves
 * exactly as before and never blocks on a missing telemetry backend. Endpoint,
 * headers, protocol, service name, and sampling are all read from OTEL_* env
 * vars by the SDK.
 */
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  // Reuse each service's existing SERVICE_NAME as the OTel resource name, so a
  // deployment needs only the shared OTEL env and no per-service name var.
  if (!process.env.OTEL_SERVICE_NAME && process.env.SERVICE_NAME) {
    process.env.OTEL_SERVICE_NAME = process.env.SERVICE_NAME;
  }

  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Filesystem spans are pure noise and dwarf everything else in volume.
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });

  sdk.start();

  // Flush spans on the same signals the HTTP server drains on.
  const stop = () => {
    sdk.shutdown().catch(() => {});
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
