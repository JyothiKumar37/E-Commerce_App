import { createPool, checkConnection } from "@ecom/shared";
import { config } from "../config.js";
import { logger } from "./logger.js";

export const pool = createPool({
  connectionString: config.DATABASE_URL,
  max: config.PG_POOL_MAX,
  logger,
});

export const checkDatabase = () => checkConnection(pool);
