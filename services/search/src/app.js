import { checkConnection, createApp, registerHealthRoutes } from "@ecom/shared";
import { config } from "./config.js";
import { logger } from "./lib/logger.js";
import { pool } from "./lib/db.js";
import { checkElastic } from "./lib/elastic.js";
import { buildRouter } from "./routes.js";

export function buildApp() {
  const app = createApp({
    serviceName: config.SERVICE_NAME,
    logger,
    corsOrigins: config.CORS_ORIGINS,
  });

  registerHealthRoutes(app, {
    serviceName: config.SERVICE_NAME,
    checks: { postgres: () => checkConnection(pool), elasticsearch: checkElastic },
  });

  app.use("/", buildRouter());
  return app;
}
