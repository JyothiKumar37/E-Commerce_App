import { createApp, registerHealthRoutes } from "@ecom/shared";
import { config } from "./config.js";
import { logger } from "./lib/logger.js";
import { checkCache } from "./lib/redis.js";
import { buildRouter } from "./routes.js";

export function buildApp() {
  const app = createApp({
    serviceName: config.SERVICE_NAME,
    logger,
    corsOrigins: config.CORS_ORIGINS,
  });

  registerHealthRoutes(app, {
    serviceName: config.SERVICE_NAME,
    checks: { redis: checkCache },
  });

  app.use("/", buildRouter());
  return app;
}
