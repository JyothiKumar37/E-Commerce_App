import { start } from "@ecom/shared";
import { config } from "./config.js";
import { logger } from "./lib/logger.js";
import { connectRedis, redisClient } from "./lib/redis.js";
import { buildApp } from "./app.js";

await connectRedis();

start({
  app: buildApp(),
  port: config.PORT,
  serviceName: config.SERVICE_NAME,
  logger,
  onShutdown: [async () => redisClient.isOpen && redisClient.quit()],
});
