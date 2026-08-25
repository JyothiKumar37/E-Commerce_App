export {
  AppError,
  ErrorCodes,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  unprocessable,
  tooManyRequests,
  internal,
  badGateway,
  serviceUnavailable,
  gatewayTimeout,
} from "./errors.js";

export { asyncHandler, errorHandler, notFoundHandler, paginated } from "./http.js";

export {
  createLogger,
  requestLogger,
  requestContext,
  currentRequestId,
  REQUEST_ID_HEADER,
} from "./logger.js";

export { validate, uuid, paginationSchema, idParam, Joi } from "./validate.js";

export {
  TOKEN_AUDIENCE,
  TOKEN_ISSUER,
  signAccessToken,
  signInternalToken,
  verifyToken,
  extractBearer,
  requireAuth,
  requireRole,
  generateRefreshToken,
  hashToken,
  safeEqual,
} from "./auth.js";

export {
  createPool,
  checkConnection,
  withTransaction,
  withRetryableTransaction,
  buildUpdateSet,
} from "./postgres.js";

export { createRedisClient, checkRedis, getJson, setJson } from "./redis.js";

export { createServiceClient } from "./serviceClient.js";

export { createApp, registerHealthRoutes, start } from "./server.js";

export {
  registry,
  httpRequestDuration,
  recordHttpRequest,
  metricsText,
  metricsContentType,
} from "./metrics.js";

export {
  loadConfig,
  baseEnvSchema,
  postgresEnvSchema,
  redisEnvSchema,
  elasticEnvSchema,
} from "./config.js";

export { createRateLimiter, createAuthRateLimiter } from "./rateLimit.js";

export {
  DEFAULT_CURRENCY,
  toCents,
  fromCents,
  formatMoney,
  sumCents,
  calculateTax,
  calculateShipping,
  calculateTotals,
} from "./money.js";

export { createIdempotencyStore, requireIdempotencyKey, fingerprint } from "./idempotency.js";
