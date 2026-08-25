import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { trace, context } from "@opentelemetry/api";
import { recordHttpRequest } from "./metrics.js";

/** Per-request store so every log line can carry the correlation id. */
export const requestContext = new AsyncLocalStorage();

export const REQUEST_ID_HEADER = "x-request-id";

/**
 * Paths redacted from every log record.
 *
 * The old gateway logged the entire axios request config, which wrote user
 * JWTs into `logs/combined.log` in plaintext. Redaction is centralised here so
 * no service can reintroduce that.
 */
const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-internal-token']",
  "req.headers['set-cookie']",
  "res.headers['set-cookie']",
  "headers.authorization",
  "headers.cookie",
  "config.headers.Authorization",
  "config.headers.authorization",
  "password",
  "passwordHash",
  "password_hash",
  "currentPassword",
  "newPassword",
  "token",
  "accessToken",
  "refreshToken",
  "refresh_token",
  "cardNumber",
  "cvv",
  "*.password",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
];

export function createLogger({ service, level, pretty } = {}) {
  const isProd = process.env.NODE_ENV === "production";
  const usePretty = pretty ?? (!isProd && process.env.LOG_PRETTY !== "false");

  return pino({
    name: service ?? process.env.SERVICE_NAME ?? "app",
    level: level ?? process.env.LOG_LEVEL ?? (isProd ? "info" : "debug"),
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    base: {
      service: service ?? process.env.SERVICE_NAME ?? "app",
      env: process.env.NODE_ENV ?? "development",
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
    // Attach the correlation id to every line emitted inside a request.
    mixin() {
      const store = requestContext.getStore();
      const fields = store?.requestId ? { requestId: store.requestId } : {};
      // Correlate logs with traces: attach the active span's ids when the
      // OTel SDK is running. Absent an active span (or in local/test runs
      // with no SDK) this is simply omitted - logging never depends on it.
      const spanContext = trace.getSpan(context.active())?.spanContext();
      if (spanContext?.traceId) {
        fields.trace_id = spanContext.traceId;
        fields.span_id = spanContext.spanId;
      }
      return fields;
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    transport: usePretty
      ? {
          target: "pino/file",
          options: { destination: 1 },
        }
      : undefined,
  });
}

/**
 * Establishes the correlation id for the request and logs completion.
 * Accepts an inbound `x-request-id` so a trace survives the gateway hop.
 */
export function requestLogger(logger) {
  return (req, res, next) => {
    const requestId = req.headers[REQUEST_ID_HEADER] ?? randomUUID();
    req.id = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);

    requestContext.run({ requestId }, () => {
      const startedAt = process.hrtime.bigint();

      res.on("finish", () => {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

        // RED metrics reuse the timing we already compute. Label by the
        // matched route TEMPLATE, never req.originalUrl, to bound cardinality.
        recordHttpRequest({
          method: req.method,
          route: req.route ? (req.baseUrl || "") + req.route.path : "unmatched",
          status: res.statusCode,
          durationSeconds: durationMs / 1000,
        });

        const payload = {
          method: req.method,
          path: req.originalUrl,
          status: res.statusCode,
          durationMs: Math.round(durationMs * 100) / 100,
          userId: req.auth?.userId,
        };

        if (res.statusCode >= 500) logger.error(payload, "request failed");
        else if (res.statusCode >= 400) logger.warn(payload, "request rejected");
        else logger.debug(payload, "request completed");
      });

      next();
    });
  };
}

export function currentRequestId() {
  return requestContext.getStore()?.requestId;
}
