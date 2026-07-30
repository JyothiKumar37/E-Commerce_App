import express from "express";
import helmet from "helmet";
import cors from "cors";
import compression from "compression";
import cookieParser from "cookie-parser";
import { AppError } from "./errors.js";
import { errorHandler, notFoundHandler } from "./http.js";
import { requestLogger } from "./logger.js";

/**
 * Builds an Express app with the middleware every service needs, in the right
 * order. Each service then mounts its routes and calls `start()`.
 */
export function createApp({
  serviceName,
  logger,
  corsOrigins,
  bodyLimit = "256kb",
  trustProxy = 1,
  enableCookies = false,
}) {
  const app = express();

  // Behind an ALB/nginx: required for correct client IPs in rate limiting.
  app.set("trust proxy", trustProxy);
  app.disable("x-powered-by");
  app.set("etag", "strong");

  app.use(
    helmet({
      contentSecurityPolicy: false, // APIs serve JSON; the SPA sets its own CSP
      crossOriginResourcePolicy: { policy: "cross-origin" },
      hsts: process.env.NODE_ENV === "production" ? { maxAge: 15_552_000 } : false,
    }),
  );

  app.use(cors(buildCorsOptions(corsOrigins)));
  app.use(compression());
  app.use(express.json({ limit: bodyLimit }));
  app.use(express.urlencoded({ extended: true, limit: bodyLimit }));
  if (enableCookies) app.use(cookieParser());
  app.use(requestLogger(logger));

  app.locals.serviceName = serviceName;
  return app;
}

/**
 * CORS with an explicit allowlist and credentials enabled.
 *
 * Every service previously ran `cors({ origin: "*" })`. A wildcard origin is
 * incompatible with the httpOnly refresh cookie the gateway now sets, and it
 * let any site on the internet call the API with the user's ambient
 * credentials.
 */
function buildCorsOptions(corsOrigins) {
  const allowlist = normaliseOrigins(corsOrigins);

  return {
    credentials: true,
    maxAge: 86_400,
    exposedHeaders: ["x-request-id", "ratelimit-limit", "ratelimit-remaining", "ratelimit-reset"],
    allowedHeaders: ["content-type", "authorization", "idempotency-key", "x-request-id"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    origin(origin, callback) {
      // Same-origin, curl, and server-to-server requests send no Origin.
      if (!origin) return callback(null, true);
      if (allowlist.includes("*")) return callback(null, true);
      if (allowlist.includes(origin)) return callback(null, true);
      return callback(
        new AppError({
          message: `Origin ${origin} is not allowed`,
          statusCode: 403,
          errorCode: "CORS_ORIGIN_DENIED",
        }),
      );
    },
  };
}

function normaliseOrigins(value) {
  if (Array.isArray(value)) return value.map((v) => v.trim()).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Registers /healthz (liveness — is the process up?) and /readyz (readiness —
 * can it serve traffic?). Kubernetes and Compose both need these to be
 * distinct: a failing dependency should stop traffic, not restart the pod.
 */
export function registerHealthRoutes(app, { serviceName, version = "1.0.0", checks = {} }) {
  const startedAt = Date.now();

  app.get("/healthz", (req, res) => {
    res.json({
      status: "ok",
      service: serviceName,
      version,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    });
  });

  app.get("/readyz", async (req, res) => {
    const results = {};
    let healthy = true;

    await Promise.all(
      Object.entries(checks).map(async ([name, check]) => {
        try {
          await check();
          results[name] = { status: "ok" };
        } catch (err) {
          healthy = false;
          results[name] = { status: "error", message: err.message };
        }
      }),
    );

    res.status(healthy ? 200 : 503).json({
      status: healthy ? "ready" : "degraded",
      service: serviceName,
      checks: results,
    });
  });
}

/**
 * Starts the HTTP server and wires graceful shutdown: stop accepting new
 * connections, let in-flight requests drain, then close pools. Without this a
 * rolling deploy drops requests and leaks Postgres connections.
 */
export function start({
  app,
  port,
  serviceName,
  logger,
  onShutdown = [],
  drainTimeoutMs = 15_000,
}) {
  app.use(notFoundHandler);
  app.use(errorHandler(logger));

  const server = app.listen(port, "0.0.0.0", () => {
    logger.info({ port, serviceName, pid: process.pid }, `${serviceName} listening on :${port}`);
  });

  // Slightly above a typical 60s ALB idle timeout to avoid races.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutdown initiated");

    const forceExit = setTimeout(() => {
      logger.error("graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, drainTimeoutMs);
    forceExit.unref();

    server.close(async (err) => {
      if (err) logger.error({ err: { message: err.message } }, "error closing http server");
      for (const hook of onShutdown) {
        try {
          await hook();
        } catch (hookErr) {
          logger.error({ err: { message: hookErr.message } }, "shutdown hook failed");
        }
      }
      clearTimeout(forceExit);
      logger.info("shutdown complete");
      process.exit(err ? 1 : 0);
    });
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  process.on("unhandledRejection", (reason) => {
    logger.error(
      { err: { message: String(reason?.message ?? reason), stack: reason?.stack } },
      "unhandled rejection",
    );
  });
  process.on("uncaughtException", (err) => {
    logger.fatal({ err: { message: err.message, stack: err.stack } }, "uncaught exception");
    shutdown("uncaughtException");
  });

  return server;
}
