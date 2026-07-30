import { Joi, loadConfig, baseEnvSchema, postgresEnvSchema, elasticEnvSchema } from "@ecom/shared";

export const config = loadConfig(
  Joi.object({
    ...baseEnvSchema,
    ...postgresEnvSchema,
    ...elasticEnvSchema,
    SERVICE_NAME: Joi.string().default("search"),
    PORT: Joi.number().port().default(8090),
    /** How often the outbox worker drains pending catalog changes into ES. */
    INDEXER_INTERVAL_MS: Joi.number().integer().min(500).default(5_000),
    INDEXER_BATCH_SIZE: Joi.number().integer().min(1).max(500).default(100),
    INDEXER_ENABLED: Joi.boolean().default(true),
  }),
);
