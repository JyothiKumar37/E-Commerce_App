import {
  createApp,
  createAuthRateLimiter,
  createRateLimiter,
  registerHealthRoutes,
} from "@ecom/shared";
import { config } from "./config.js";
import { logger } from "./lib/logger.js";
import { checkDatabase } from "./lib/db.js";
import { checkCache, redisClient } from "./lib/redis.js";
import { buildAuthRouter, mountRoutes, ROUTE_TABLE } from "./routes.js";

/**
 * Assembles the gateway. Pure construction — opening connections is the
 * entrypoint's job, so tests can build the app without touching the network.
 */
export function buildApp() {
  const app = createApp({
    serviceName: config.SERVICE_NAME,
    logger,
    corsOrigins: config.CORS_ORIGINS,
    enableCookies: true,
  });

  registerHealthRoutes(app, {
    serviceName: config.SERVICE_NAME,
    checks: { postgres: checkDatabase, redis: checkCache },
  });

  // Global limiter first, so a flood cannot exhaust the pool before the
  // per-endpoint limiters are reached.
  app.use(
    createRateLimiter({
      redisClient,
      windowMs: config.RATE_LIMIT_WINDOW_MS,
      max: config.RATE_LIMIT_MAX,
      keyBy: "user",
      prefix: "rl:gw:",
      logger,
    }),
  );

  const authLimiter = createAuthRateLimiter({
    redisClient,
    max: config.AUTH_RATE_LIMIT_MAX,
    logger,
  });

  app.use("/auth", buildAuthRouter({ authLimiter }));

  // Discovery document; handy for smoke tests and an "is the backend up?" ping.
  app.get("/", (req, res) => {
    res.json({
      service: "ecom-api-gateway",
      version: "1.0.0",
      routes: ["/auth", ...ROUTE_TABLE.map((r) => r.path)],
    });
  });

  mountRoutes(app);

  return app;
}
