/**
 * Single error type for the whole platform.
 *
 * The old code had four copies of an `ErrorResponse` class whose constructor
 * destructured an options object, but several call sites used the positional
 * form `new ErrorResponse("msg", 404)` — which silently produced an error with
 * `message: undefined` and `statusCode: undefined`. This constructor accepts
 * both shapes so that mistake cannot resurface, and normalises the result.
 */
export class AppError extends Error {
  constructor(messageOrOptions, maybeStatusCode) {
    const options =
      typeof messageOrOptions === "string"
        ? { message: messageOrOptions, statusCode: maybeStatusCode }
        : (messageOrOptions ?? {});

    const {
      message = "Internal Server Error",
      statusCode = 500,
      errorType,
      errorCode = "INTERNAL_ERROR",
      details,
      cause,
      expose,
    } = options;

    super(message, cause ? { cause } : undefined);

    this.name = "AppError";
    this.statusCode = Number.isInteger(statusCode) ? statusCode : 500;
    this.errorType = errorType ?? defaultErrorType(this.statusCode);
    this.errorCode = errorCode;
    this.details = details;
    // 4xx messages are safe to show a client; 5xx messages may leak internals.
    this.expose = expose ?? this.statusCode < 500;
    this.isAppError = true;

    Error.captureStackTrace?.(this, AppError);
  }

  toJSON() {
    return {
      message: this.message,
      errorType: this.errorType,
      errorCode: this.errorCode,
      statusCode: this.statusCode,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

function defaultErrorType(statusCode) {
  const map = {
    400: "BadRequest",
    401: "Unauthorized",
    403: "Forbidden",
    404: "NotFound",
    409: "Conflict",
    410: "Gone",
    422: "UnprocessableEntity",
    429: "TooManyRequests",
    500: "InternalServerError",
    502: "BadGateway",
    503: "ServiceUnavailable",
    504: "GatewayTimeout",
  };
  return map[statusCode] ?? (statusCode < 500 ? "BadRequest" : "InternalServerError");
}

const factory =
  (statusCode) =>
  (message, options = {}) =>
    new AppError({ message, statusCode, ...options });

export const badRequest = factory(400);
export const unauthorized = factory(401);
export const forbidden = factory(403);
export const notFound = factory(404);
export const conflict = factory(409);
export const unprocessable = factory(422);
export const tooManyRequests = factory(429);
export const internal = factory(500);
export const badGateway = factory(502);
export const serviceUnavailable = factory(503);
export const gatewayTimeout = factory(504);

/** Stable error codes shared across services so clients can branch on them. */
export const ErrorCodes = {
  // auth
  EMAIL_TAKEN: "AUTH_EMAIL_TAKEN",
  USERNAME_TAKEN: "AUTH_USERNAME_TAKEN",
  INVALID_CREDENTIALS: "AUTH_INVALID_CREDENTIALS",
  MISSING_TOKEN: "AUTH_MISSING_TOKEN",
  INVALID_TOKEN: "AUTH_INVALID_TOKEN",
  EXPIRED_TOKEN: "AUTH_EXPIRED_TOKEN",
  INVALID_REFRESH_TOKEN: "AUTH_INVALID_REFRESH_TOKEN",
  FORBIDDEN: "AUTH_FORBIDDEN",
  ACCOUNT_DISABLED: "AUTH_ACCOUNT_DISABLED",
  // validation
  VALIDATION_FAILED: "VAL_FAILED",
  EMPTY_BODY: "VAL_EMPTY_BODY",
  // resources
  USER_NOT_FOUND: "USER_NOT_FOUND",
  ADDRESS_NOT_FOUND: "ADDRESS_NOT_FOUND",
  PRODUCT_NOT_FOUND: "PRODUCT_NOT_FOUND",
  ORDER_NOT_FOUND: "ORDER_NOT_FOUND",
  PAYMENT_NOT_FOUND: "PAYMENT_NOT_FOUND",
  SHIPMENT_NOT_FOUND: "SHIPMENT_NOT_FOUND",
  REVIEW_NOT_FOUND: "REVIEW_NOT_FOUND",
  CART_EMPTY: "CART_EMPTY",
  // domain
  INSUFFICIENT_STOCK: "INV_INSUFFICIENT_STOCK",
  RESERVATION_EXPIRED: "INV_RESERVATION_EXPIRED",
  PRICE_CHANGED: "ORDER_PRICE_CHANGED",
  PAYMENT_DECLINED: "PAY_DECLINED",
  DUPLICATE_REVIEW: "REVIEW_DUPLICATE",
  NOT_PURCHASED: "REVIEW_NOT_PURCHASED",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  ORDER_NOT_CANCELLABLE: "ORDER_NOT_CANCELLABLE",
  // infrastructure
  DB_UNAVAILABLE: "DB_UNAVAILABLE",
  SEARCH_UNAVAILABLE: "SEARCH_UNAVAILABLE",
  UPSTREAM_TIMEOUT: "UPSTREAM_TIMEOUT",
  UPSTREAM_ERROR: "UPSTREAM_ERROR",
  RATE_LIMITED: "RATE_LIMITED",
};
