import { start } from "@ecom/shared";
import { config } from "./config.js";
import { logger } from "./lib/logger.js";
import { checkDatabase, pool } from "./lib/db.js";
import { connectRedis, redisClient } from "./lib/redis.js";
import { buildApp } from "./app.js";

// Verify both dependencies before opening the port, so an orchestrator never
// routes traffic to an instance that cannot serve it.
await checkDatabase();
await connectRedis();
logger.info("dependencies verified");

start({
  app: buildApp(),
  port: config.PORT,
  serviceName: config.SERVICE_NAME,
  logger,
  onShutdown: [async () => redisClient.isOpen && redisClient.quit(), async () => pool.end()],
});
