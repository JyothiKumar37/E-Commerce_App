import { Joi, loadConfig, baseEnvSchema, postgresEnvSchema } from "@ecom/shared";

export const config = loadConfig(
  Joi.object({
    ...baseEnvSchema,
    ...postgresEnvSchema,
    SERVICE_NAME: Joi.string().default("account"),
    PORT: Joi.number().port().default(8081),
    MAX_ADDRESSES_PER_USER: Joi.number().integer().min(1).max(100).default(20),
  }),
);
