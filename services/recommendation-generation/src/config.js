import { Joi, loadConfig, baseEnvSchema, postgresEnvSchema } from "@ecom/shared";

export const config = loadConfig(
  Joi.object({
    ...baseEnvSchema,
    ...postgresEnvSchema,
    SERVICE_NAME: Joi.string().default("recommendation-generation"),
    PORT: Joi.number().port().default(8089),
    /** Batch cadence. Set RUN_ON_SCHEDULE=false to drive it purely by API. */
    RUN_ON_SCHEDULE: Joi.boolean().default(true),
    RUN_INTERVAL_MS: Joi.number()
      .integer()
      .min(60_000)
      .default(6 * 3600 * 1000),
    RUN_ON_BOOT: Joi.boolean().default(false),
    /** Recommendations kept per user. */
    RECOMMENDATIONS_PER_USER: Joi.number().integer().min(1).max(100).default(20),
    /** Related products kept per product. */
    AFFINITY_PER_PRODUCT: Joi.number().integer().min(1).max(50).default(10),
    /** Ignore pairs seen fewer than this many times; below it is noise. */
    MIN_CO_OCCURRENCES: Joi.number().integer().min(1).default(2),
  }),
);
