import { checkConnection, start } from "@ecom/shared";
import { config } from "./config.js";
import { logger } from "./lib/logger.js";
import { pool } from "./lib/db.js";
import { buildApp } from "./app.js";

// Verify dependencies before opening the port, so an orchestrator never routes
// traffic to an instance that cannot serve it.
await checkConnection(pool);

start({
  app: buildApp(),
  port: config.PORT,
  serviceName: config.SERVICE_NAME,
  logger,
  onShutdown: [() => pool.end()],
});
