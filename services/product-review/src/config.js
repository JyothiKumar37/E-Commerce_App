import { Joi, loadConfig, baseEnvSchema, postgresEnvSchema } from "@ecom/shared";

export const config = loadConfig(
  Joi.object({
    ...baseEnvSchema,
    ...postgresEnvSchema,
    SERVICE_NAME: Joi.string().default("product-review"),
    PORT: Joi.number().port().default(8087),
    /** When true, only customers who actually bought the item may review it. */
    REQUIRE_VERIFIED_PURCHASE: Joi.boolean().default(false),
  }),
);
