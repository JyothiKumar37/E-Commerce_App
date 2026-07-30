import { AppError, ErrorCodes, notFound } from "./errors.js";

/**
 * Wraps an async handler so rejections reach Express' error pipeline.
 *
 * The old version did `Promise.resolve(fn(...)).catch(next)`. When such a
 * handler was invoked outside a request (as `setupElasticsearch` did at boot,
 * calling it with three undefined arguments) `.catch(undefined)` became a
 * pass-through and the rejection escaped as an unhandled promise rejection,
 * which terminates the process on Node >= 15. Guarding on `typeof next` makes
 * misuse loud instead of fatal.
 */
export const asyncHandler = (fn) =>
  function wrapped(req, res, next) {
    if (typeof next !== "function") {
      return Promise.reject(
        new TypeError(
          `asyncHandler(${fn.name || "anonymous"}) was called outside an Express ` +
            "request. Route handlers must not be invoked directly.",
        ),
      );
    }
    return Promise.resolve(fn(req, res, next)).catch(next);
  };

/** 404 for unmatched routes; must be registered before the error handler. */
export const notFoundHandler = (req, res, next) => {
  next(
    notFound(`Route ${req.method} ${req.originalUrl} not found`, {
      errorCode: "ROUTE_NOT_FOUND",
    }),
  );
};

/**
 * Terminal error middleware. Every service mounts this — the account and
 * search services previously had none, so their carefully constructed errors
 * fell through to Express' default handler and returned HTML with a stack
 * trace instead of the JSON envelope clients expect.
 */
export function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars -- Express requires arity 4.
  return (err, req, res, next) => {
    const appError = normalise(err);

    const logPayload = {
      err: {
        message: err?.message,
        stack: err?.stack,
        code: err?.code,
        errorCode: appError.errorCode,
      },
      method: req.method,
      path: req.originalUrl,
      status: appError.statusCode,
      userId: req.auth?.userId,
    };

    if (appError.statusCode >= 500) logger.error(logPayload, "unhandled error");
    else logger.warn(logPayload, "request error");

    if (res.headersSent) return res.end();

    res.status(appError.statusCode).json({
      error: {
        message: appError.expose ? appError.message : "Internal Server Error",
        errorType: appError.errorType,
        errorCode: appError.errorCode,
        statusCode: appError.statusCode,
        ...(appError.expose && appError.details ? { details: appError.details } : {}),
        requestId: req.id,
      },
    });
  };
}

function normalise(err) {
  if (err?.isAppError) return err;

  // Body parser rejected malformed JSON.
  if (err?.type === "entity.parse.failed") {
    return new AppError({
      message: "Malformed JSON body",
      statusCode: 400,
      errorCode: ErrorCodes.VALIDATION_FAILED,
    });
  }
  if (err?.type === "entity.too.large") {
    return new AppError({
      message: "Request body too large",
      statusCode: 413,
      errorCode: "PAYLOAD_TOO_LARGE",
    });
  }

  // Postgres driver errors -> stable, non-leaking responses.
  const pg = mapPostgresError(err);
  if (pg) return pg;

  return new AppError({
    message: err?.message ?? "Internal Server Error",
    statusCode: err?.statusCode ?? err?.status ?? 500,
    errorCode: ErrorCodes.DB_UNAVAILABLE === err?.code ? err.code : "INTERNAL_ERROR",
    cause: err,
  });
}

function mapPostgresError(err) {
  switch (err?.code) {
    case "23505": // unique_violation
      return new AppError({
        message: "A record with these values already exists",
        statusCode: 409,
        errorCode: "DB_UNIQUE_VIOLATION",
        details: err.constraint ? { constraint: err.constraint } : undefined,
      });
    case "23503": // foreign_key_violation
      return new AppError({
        message: "Referenced record does not exist",
        statusCode: 409,
        errorCode: "DB_FOREIGN_KEY_VIOLATION",
      });
    case "23514": // check_violation
      return new AppError({
        message: "Value violates a database constraint",
        statusCode: 400,
        errorCode: "DB_CHECK_VIOLATION",
      });
    case "40001": // serialization_failure
    case "40P01": // deadlock_detected
      return new AppError({
        message: "Conflicting concurrent update, please retry",
        statusCode: 409,
        errorCode: "DB_CONFLICT",
      });
    case "ECONNREFUSED":
    case "57P01": // admin_shutdown
      return new AppError({
        message: "Database unavailable",
        statusCode: 503,
        errorCode: ErrorCodes.DB_UNAVAILABLE,
      });
    default:
      return null;
  }
}

/** Small helper for consistent list envelopes. */
export const paginated = (items, { page, pageSize, total }) => ({
  items,
  page,
  pageSize,
  total,
  totalPages: pageSize > 0 ? Math.ceil(total / pageSize) : 0,
  hasNext: page * pageSize < total,
});
