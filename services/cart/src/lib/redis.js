import { createRedisClient, checkRedis } from "@ecom/shared";
import { config } from "../config.js";
import { logger } from "./logger.js";

export const redisClient = createRedisClient({
  url: config.REDIS_URL,
  logger,
  name: "cart",
});

export const connectRedis = async () => {
  if (!redisClient.isOpen) await redisClient.connect();
  return redisClient;
};

export const checkCache = () => checkRedis(redisClient);
