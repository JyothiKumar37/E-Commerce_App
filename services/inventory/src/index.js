import { checkConnection, start } from "@ecom/shared";
import { config } from "./config.js";
import { logger } from "./lib/logger.js";
import { pool } from "./lib/db.js";
import { startSweeper, stopSweeper } from "./services/inventoryService.js";
import { buildApp } from "./app.js";

await checkConnection(pool);

// Reclaims stock held by checkouts that were abandoned or crashed.
startSweeper();

start({
  app: buildApp(),
  port: config.PORT,
  serviceName: config.SERVICE_NAME,
  logger,
  onShutdown: [async () => stopSweeper(), () => pool.end()],
});
