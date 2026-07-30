import { Joi, loadConfig, baseEnvSchema, postgresEnvSchema } from "@ecom/shared";

export const config = loadConfig(
  Joi.object({
    ...baseEnvSchema,
    ...postgresEnvSchema,
    SERVICE_NAME: Joi.string().default("payment"),
    PORT: Joi.number().port().default(8085),

    /**
     * `mock` simulates a PSP deterministically for local development and tests.
     * A real integration adds a `stripe` / `adyen` provider alongside it.
     */
    PAYMENT_PROVIDER: Joi.string().valid("mock").default("mock"),

    /**
     * The mock provider approves payments without taking money. Booting it in
     * production would mean every order ships unpaid — the single most
     * expensive misconfiguration in this system, and one that produces no
     * error until an accountant notices.
     *
     * Refusing to start is the only safe default. The override exists because
     * a staging environment may legitimately run `NODE_ENV=production` against
     * a fake PSP, but it has to be typed out deliberately.
     */
    ALLOW_MOCK_PAYMENTS_IN_PRODUCTION: Joi.boolean().default(false),

    /** Probability a mock card payment is declined, so the failure path is exercised. */
    MOCK_DECLINE_RATE: Joi.number().min(0).max(1).default(0),
    MOCK_LATENCY_MS: Joi.number().integer().min(0).max(10_000).default(150),
  }).custom((value, helpers) => {
    if (
      value.NODE_ENV === "production" &&
      value.PAYMENT_PROVIDER === "mock" &&
      value.ALLOW_MOCK_PAYMENTS_IN_PRODUCTION !== true
    ) {
      return helpers.message(
        "PAYMENT_PROVIDER is 'mock' with NODE_ENV=production. The mock provider " +
          "approves payments without charging anyone. Configure a real provider, or set " +
          "ALLOW_MOCK_PAYMENTS_IN_PRODUCTION=true if this is a staging environment.",
      );
    }
    return value;
  }),
);
