import { createServiceClient } from "@ecom/shared";
import { config } from "../config.js";
import { logger } from "./logger.js";

export const inventoryClient = createServiceClient({
  name: "inventory",
  baseURL: config.INVENTORY_SERVICE_URL,
  internalSecret: config.INTERNAL_JWT_SECRET,
  logger,
});
