import { Joi, loadConfig, baseEnvSchema, postgresEnvSchema } from "@ecom/shared";

export const config = loadConfig(
  Joi.object({
    ...baseEnvSchema,
    ...postgresEnvSchema,
    SERVICE_NAME: Joi.string().default("inventory"),
    PORT: Joi.number().port().default(8083),
    /** How long a checkout may hold stock before it is released again. */
    RESERVATION_TTL_SECONDS: Joi.number().integer().min(60).default(900),
    SWEEPER_INTERVAL_MS: Joi.number().integer().min(1_000).default(60_000),
    SWEEPER_ENABLED: Joi.boolean().default(true),
  }),
);
