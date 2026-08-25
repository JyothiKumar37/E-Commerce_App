import client from "prom-client";

/**
 * One Prometheus registry per process. Every service inherits it through the
 * shared server, so metric names and labels stay identical platform-wide.
 */
export const registry = new client.Registry();

// Resident memory, event-loop lag, CPU, GC, handles - the process-health basics.
client.collectDefaultMetrics({ register: registry });

/**
 * RED request signals in a single histogram: its _count series gives Rate and
 * Errors (by status label), its buckets give Duration. One observation per
 * request covers all three.
 *
 * Labels are deliberately bounded - method, route TEMPLATE (never the resolved
 * path: /products/:id, not /products/abc123), and status. Free-form paths or
 * user ids would explode cardinality and take Prometheus down with the very
 * traffic they measure.
 */
export const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds, labelled by method, route and status.",
  labelNames: ["method", "route", "status"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

/**
 * Records one request against the histogram. Called from requestLogger on the
 * response "finish" event, reusing the timing it already computes.
 */
export function recordHttpRequest({ method, route, status, durationSeconds }) {
  httpRequestDuration.observe(
    { method, route: route || "unmatched", status: String(status) },
    durationSeconds,
  );
}

/** Serialises the registry in Prometheus text exposition format. */
export function metricsText() {
  return registry.metrics();
}

export const metricsContentType = registry.contentType;
