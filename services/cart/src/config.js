import { Joi, loadConfig, baseEnvSchema, redisEnvSchema } from "@ecom/shared";

export const config = loadConfig(
  Joi.object({
    ...baseEnvSchema,
    ...redisEnvSchema,
    SERVICE_NAME: Joi.string().default("cart"),
    PORT: Joi.number().port().default(8082),
    SEARCH_SERVICE_URL: Joi.string()
      .uri({ scheme: ["http", "https"] })
      .required(),
    /** Abandoned carts expire rather than accumulating in Redis forever. */
    CART_TTL_SECONDS: Joi.number()
      .integer()
      .min(300)
      .default(30 * 24 * 3600),
    MAX_LINE_ITEMS: Joi.number().integer().min(1).max(200).default(50),
    MAX_QUANTITY_PER_ITEM: Joi.number().integer().min(1).max(1000).default(20),
  }),
);
