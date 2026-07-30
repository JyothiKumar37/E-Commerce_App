import { Joi, loadConfig, baseEnvSchema, postgresEnvSchema, redisEnvSchema } from "@ecom/shared";

const serviceUrl = Joi.string().uri({ scheme: ["http", "https"] });

export const config = loadConfig(
  Joi.object({
    ...baseEnvSchema,
    ...postgresEnvSchema,
    ...redisEnvSchema,
    SERVICE_NAME: Joi.string().default("place-order"),
    PORT: Joi.number().port().default(8086),

    ACCOUNT_SERVICE_URL: serviceUrl.required(),
    CART_SERVICE_URL: serviceUrl.required(),
    INVENTORY_SERVICE_URL: serviceUrl.required(),
    PAYMENT_SERVICE_URL: serviceUrl.required(),
    SHIPPING_SERVICE_URL: serviceUrl.required(),

    TAX_RATE: Joi.number().min(0).max(1).default(0.19),
    FREE_SHIPPING_THRESHOLD_CENTS: Joi.number().integer().min(0).default(5000),
    FLAT_SHIPPING_CENTS: Joi.number().integer().min(0).default(499),
  }),
);
