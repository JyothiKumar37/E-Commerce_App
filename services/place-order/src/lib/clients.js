import { createServiceClient } from "@ecom/shared";
import { config } from "../config.js";
import { logger } from "./logger.js";

const make = (name, baseURL, timeout = 5_000) =>
  createServiceClient({
    name,
    baseURL,
    internalSecret: config.INTERNAL_JWT_SECRET,
    timeout,
    logger,
  });

export const accountClient = make("account", config.ACCOUNT_SERVICE_URL);
export const cartClient = make("cart", config.CART_SERVICE_URL);
export const inventoryClient = make("inventory", config.INVENTORY_SERVICE_URL);
// Payment gets a longer budget: a PSP round trip is the slowest hop in checkout.
export const paymentClient = make("payment", config.PAYMENT_SERVICE_URL, 15_000);
export const shippingClient = make("shipping", config.SHIPPING_SERVICE_URL);
