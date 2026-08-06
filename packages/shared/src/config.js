import Joi from "joi";

/**
 * Validates and coerces `process.env` against a Joi schema at boot.
 *
 * The old `validateEnvs()` only checked for presence and threw a bare Error on
 * the first missing key. This reports every problem at once, applies defaults,
 * and coerces types so services never compare a port number against a string.
 */
export function loadConfig(schema, env = process.env) {
  const { value, error } = schema
    .prefs({ abortEarly: false, allowUnknown: true, convert: true })
    .validate(env);

  if (error) {
    const problems = error.details.map((d) => `  - ${d.message}`).join("\n");
    // Fail loudly at boot, not lazily on the first request that needs the value.
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }

  return Object.freeze(value);
}

/** Fields every service shares. */
export const baseEnvSchema = {
  NODE_ENV: Joi.string().valid("development", "test", "production").default("development"),
  LOG_LEVEL: Joi.string().valid("fatal", "error", "warn", "info", "debug", "trace").default("info"),
  SERVICE_NAME: Joi.string().default("service"),
  /**
   * Comma-separated allowlist. Convenient in development, mandatory and
   * non-local in production: shipping with the localhost default would either
   * break every browser call or, if someone "fixed" it with `*`, disable the
   * origin check entirely on a credentialed API.
   */
  CORS_ORIGINS: Joi.string().when("NODE_ENV", {
    is: "production",
    then: Joi.string()
      .required()
      .custom((value, helpers) => {
        const origins = value
          .split(",")
          .map((o) => o.trim())
          .filter(Boolean);
        if (origins.includes("*")) {
          return helpers.message(
            "CORS_ORIGINS must not be '*' in production: the API sends credentials, " +
              "so a wildcard origin would expose it to every site on the internet.",
          );
        }
        const local = origins.find((o) => /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(o));
        if (local) {
          return helpers.message(
            `CORS_ORIGINS still contains a local origin (${local}) in production. ` +
              "Set it to the real storefront origin.",
          );
        }
        return value;
      }),
    otherwise: Joi.string().default("http://localhost:5173"),
  }),
  /**
   * Secret used to sign gateway -> service tokens. 32 chars minimum: HS256 with
   * a short secret is brute-forceable offline.
   */
  INTERNAL_JWT_SECRET: Joi.string().min(32).required().messages({
    "string.min": "INTERNAL_JWT_SECRET must be at least 32 characters",
    "any.required": "INTERNAL_JWT_SECRET is required (generate with: openssl rand -base64 48)",
  }),
};

export const postgresEnvSchema = {
  DATABASE_URL: Joi.string()
    .uri({ scheme: ["postgres", "postgresql"] })
    .required(),
  /**
   * TLS to Postgres.
   *
   * `disable` is right for local Docker and for a single-host deployment where
   * Postgres sits on a private bridge network the traffic never leaves. It is
   * wrong the moment the database is across a network — it would send
   * credentials and order data in the clear — so production rejects it unless
   * the same-host topology is stated explicitly.
   */
  ALLOW_INSECURE_DB_CONNECTION: Joi.boolean().default(false),
  PGSSLMODE: Joi.string().when("NODE_ENV", {
    is: "production",
    then: Joi.when("ALLOW_INSECURE_DB_CONNECTION", {
      is: true,
      then: Joi.string().valid("disable", "require", "no-verify").default("disable"),
      otherwise: Joi.string()
        .valid("require", "no-verify")
        .default("require")
        .messages({
          "any.only":
            "PGSSLMODE must be 'require' (or 'no-verify' for a self-signed CA) in production. " +
            "If Postgres is on the same host over a private network, set " +
            "ALLOW_INSECURE_DB_CONNECTION=true to say so deliberately.",
        }),
    }),
    otherwise: Joi.string().valid("disable", "require", "no-verify").default("disable"),
  }),
  PG_POOL_MAX: Joi.number().integer().min(1).max(100).default(10),
};

export const redisEnvSchema = {
  REDIS_URL: Joi.string()
    .uri({ scheme: ["redis", "rediss"] })
    .required(),
};

export const elasticEnvSchema = {
  ELASTICSEARCH_URL: Joi.string().uri().required(),
  ELASTICSEARCH_API_KEY: Joi.string().allow("").optional(),
  ELASTICSEARCH_USERNAME: Joi.string().allow("").optional(),
  ELASTICSEARCH_PASSWORD: Joi.string().allow("").optional(),
  ELASTICSEARCH_CA_CERT: Joi.string().allow("").optional(),
  ELASTICSEARCH_INDEX: Joi.string().default("products"),
  // Replica count for the product index. Zero is correct for a single-node
  // cluster: a replica has nowhere to be allocated, so the shard sits
  // unassigned and the cluster reports yellow for ever. Raise this only when
  // there is more than one data node to place the copy on.
  ELASTICSEARCH_REPLICAS: Joi.number().integer().min(0).max(5).default(0),
};

export { Joi };
