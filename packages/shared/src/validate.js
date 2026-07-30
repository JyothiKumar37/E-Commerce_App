import Joi from "joi";
import { AppError, ErrorCodes } from "./errors.js";

/**
 * Validates one part of the request and *replaces* it with the coerced,
 * stripped result, so handlers can only ever see whitelisted fields.
 *
 * `source` is one of "body" | "query" | "params".
 */
export function validate(schema, source = "body") {
  /**
   * Whether this schema would accept `{}`. Computed once, at route-registration
   * time, rather than per request.
   *
   * A blanket "body must not be empty" rejection was wrong: endpoints whose
   * fields are all optional — a view ping, an order cancellation with no
   * reason — legitimately take an empty body, and were being 400'd before the
   * schema ever ran. Where the body genuinely is required, Joi already says so
   * per field ("Email is required"), which is a better message anyway.
   */
  const acceptsEmptyObject = !schema.validate({}, { abortEarly: true }).error;

  return (req, res, next) => {
    const input = req[source];

    if (source === "body" && (input == null || Object.keys(input).length === 0)) {
      if (!acceptsEmptyObject) {
        return next(
          new AppError({
            message: "Request body must not be empty",
            statusCode: 400,
            errorCode: ErrorCodes.EMPTY_BODY,
          }),
        );
      }
      req.body = {};
    }

    const { value, error } = schema.validate(req[source], {
      abortEarly: false,
      stripUnknown: true,
      convert: true,
    });

    if (error) {
      return next(
        new AppError({
          message: error.details[0].message,
          statusCode: 400,
          errorCode: ErrorCodes.VALIDATION_FAILED,
          details: error.details.map((d) => ({
            field: d.path.join("."),
            message: d.message,
          })),
        }),
      );
    }

    // req.query is a getter-only property on Express 5; assign defensively.
    try {
      req[source] = value;
    } catch {
      Object.defineProperty(req, source, { value, writable: true, configurable: true });
    }
    return next();
  };
}

export const uuid = Joi.string().uuid({ version: "uuidv4" });

export const paginationSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(20),
});

/** Reusable id-in-path schema factory. */
export const idParam = (name) => Joi.object({ [name]: uuid.required() }).unknown(true);

export { Joi };
