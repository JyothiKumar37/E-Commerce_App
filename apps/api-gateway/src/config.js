import { Joi, loadConfig, baseEnvSchema, postgresEnvSchema, redisEnvSchema } from "@ecom/shared";

const serviceUrl = Joi.string().uri({ scheme: ["http", "https"] });

const schema = Joi.object({
  ...baseEnvSchema,
  ...postgresEnvSchema,
  ...redisEnvSchema,

  SERVICE_NAME: Joi.string().default("api-gateway"),
  PORT: Joi.number().port().default(8080),

  /** Signs browser-facing access tokens. Distinct from INTERNAL_JWT_SECRET so
   *  a leaked internal secret cannot mint client sessions, and vice versa. */
  JWT_SECRET: Joi.string().min(32).required().messages({
    "any.required": "JWT_SECRET is required (generate with: openssl rand -base64 48)",
  }),
  ACCESS_TOKEN_TTL: Joi.string().default("15m"),
  REFRESH_TOKEN_TTL_DAYS: Joi.number().integer().min(1).max(365).default(30),
  COOKIE_DOMAIN: Joi.string().allow("").optional(),
  /**
   * Path the refresh cookie is scoped to. Must match the public URL prefix the
   * browser sees, not the gateway's internal mount point. Behind a reverse
   * proxy serving the API at `/api`, this has to be `/api/auth` — otherwise the
   * browser holds a cookie scoped to `/auth`, never sends it to
   * `/api/auth/refresh`, and every session dies silently at the access-token
   * TTL with no error anywhere.
   */
  COOKIE_PATH: Joi.string().pattern(/^\//).default("/auth"),
  COOKIE_SECURE: Joi.boolean().default(process.env.NODE_ENV === "production"),
  COOKIE_SAMESITE: Joi.string().valid("strict", "lax", "none").default("lax"),

  RATE_LIMIT_WINDOW_MS: Joi.number().integer().default(60_000),
  RATE_LIMIT_MAX: Joi.number().integer().default(300),
  AUTH_RATE_LIMIT_MAX: Joi.number().integer().default(10),

  UPSTREAM_TIMEOUT_MS: Joi.number().integer().default(8_000),

  ACCOUNT_SERVICE_URL: serviceUrl.required(),
  CART_SERVICE_URL: serviceUrl.required(),
  INVENTORY_SERVICE_URL: serviceUrl.required(),
  ORDER_STATUS_SERVICE_URL: serviceUrl.required(),
  PAYMENT_SERVICE_URL: serviceUrl.required(),
  PLACE_ORDER_SERVICE_URL: serviceUrl.required(),
  PRODUCT_REVIEW_SERVICE_URL: serviceUrl.required(),
  RECOMMENDATION_SERVICE_URL: serviceUrl.required(),
  RECOMMENDATION_GENERATION_SERVICE_URL: serviceUrl.required(),
  SEARCH_SERVICE_URL: serviceUrl.required(),
  SHIPPING_SERVICE_URL: serviceUrl.required(),
}).custom((value, helpers) => {
  // A `Secure` cookie is silently discarded by every browser on a plain-HTTP
  // response. Sign-in would appear to succeed, the refresh cookie would never
  // come back, and every session would end at the access-token TTL — with no
  // error logged anywhere, because from the server's side it just looks like a
  // request that carried no cookie.
  //
  // Refusing to boot turns the least debuggable failure in the system into a
  // one-line startup message.
  const origin = value.CORS_ORIGINS ?? "";
  const isLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(origin);

  // There used to be a separate production compose overlay, which made it
  // impossible to start the public-facing topology without also switching to
  // NODE_ENV=production. With one compose file that coupling is gone, so the
  // gateway enforces it: a non-local origin means real users can reach this,
  // and development mode silently disables every production guard — the CORS
  // check, the Postgres TLS requirement, the mock-payment refusal.
  if (origin && !isLocal && value.NODE_ENV !== "production") {
    return helpers.message(
      `CORS_ORIGINS is a public origin (${origin}) but NODE_ENV is ` +
        `"${value.NODE_ENV}". That serves real traffic with the production ` +
        "safety guards disabled. Set NODE_ENV=production.",
    );
  }

  const servesPlainHttp = /^http:\/\//i.test(origin);
  if (servesPlainHttp && value.COOKIE_SECURE === true) {
    return helpers.message(
      `COOKIE_SECURE is true but the site is served over plain HTTP (${value.CORS_ORIGINS}). ` +
        "Browsers drop Secure cookies on HTTP, so authentication would break silently. " +
        "Set COOKIE_SECURE=false for an IP/HTTP deployment, or serve the site over HTTPS.",
    );
  }
  return value;
});

export const config = loadConfig(schema);
