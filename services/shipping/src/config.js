import { Joi, loadConfig, baseEnvSchema, postgresEnvSchema } from "@ecom/shared";

export const config = loadConfig(
  Joi.object({
    ...baseEnvSchema,
    ...postgresEnvSchema,
    SERVICE_NAME: Joi.string().default("shipping"),
    PORT: Joi.number().port().default(8091),
    DEFAULT_CARRIER: Joi.string().default("DHL"),
  }),
);
