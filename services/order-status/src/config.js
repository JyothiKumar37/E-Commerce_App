import { Joi, loadConfig, baseEnvSchema, postgresEnvSchema } from "@ecom/shared";

export const config = loadConfig(
  Joi.object({
    ...baseEnvSchema,
    ...postgresEnvSchema,
    SERVICE_NAME: Joi.string().default("order-status"),
    PORT: Joi.number().port().default(8084),
    INVENTORY_SERVICE_URL: Joi.string()
      .uri({ scheme: ["http", "https"] })
      .required(),
    /** Window during which a customer may cancel without contacting support. */
    CANCELLATION_WINDOW_HOURS: Joi.number().integer().min(0).default(24),
  }),
);
