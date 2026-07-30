import { Joi, loadConfig, baseEnvSchema, postgresEnvSchema } from "@ecom/shared";

export const config = loadConfig(
  Joi.object({
    ...baseEnvSchema,
    ...postgresEnvSchema,
    SERVICE_NAME: Joi.string().default("recommendation"),
    PORT: Joi.number().port().default(8088),
    DEFAULT_LIMIT: Joi.number().integer().min(1).max(50).default(8),
  }),
);
