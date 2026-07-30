import { createHash } from "node:crypto";
import { AppError, ErrorCodes } from "./errors.js";

/**
 * Idempotency for unsafe operations (place order, capture payment).
 *
 * A client retrying a checkout after a timeout must not be charged twice. The
 * key is stored with a fingerprint of the request body: replaying the same key
 * with the same body returns the original response, while replaying it with a
 * *different* body is a 409 rather than a silent overwrite.
 */
export function fingerprint(body) {
  return createHash("sha256")
    .update(JSON.stringify(body ?? {}))
    .digest("hex");
}

const IN_FLIGHT = "__in_flight__";

/**
 * @param {object} deps
 * @param {import('redis').RedisClientType} deps.redisClient
 * @param {string} deps.scope   namespace, e.g. "place-order"
 * @param {number} deps.ttlSeconds how long a completed result is replayable
 */
export function createIdempotencyStore({ redisClient, scope, ttlSeconds = 24 * 3600 }) {
  const keyFor = (userId, key) => `idem:${scope}:${userId ?? "anon"}:${key}`;

  return {
    /**
     * Claims the key. Returns `{ status: "new" }` when the caller should do the
     * work, `{ status: "replay", result }` when a stored result exists, or
     * throws 409 when the same key is already being processed.
     */
    async begin(userId, key, body) {
      const redisKey = keyFor(userId, key);
      const bodyHash = fingerprint(body);

      const claimed = await redisClient.set(
        redisKey,
        JSON.stringify({ state: IN_FLIGHT, bodyHash }),
        { NX: true, EX: 300 },
      );

      if (claimed === "OK") return { status: "new", redisKey, bodyHash };

      const existingRaw = await redisClient.get(redisKey);
      if (!existingRaw) return { status: "new", redisKey, bodyHash };

      const existing = JSON.parse(existingRaw);

      if (existing.bodyHash !== bodyHash) {
        throw new AppError({
          message: "This Idempotency-Key was already used with a different request body",
          statusCode: 409,
          errorCode: ErrorCodes.IDEMPOTENCY_CONFLICT,
        });
      }

      if (existing.state === IN_FLIGHT) {
        throw new AppError({
          message: "An identical request is already in progress",
          statusCode: 409,
          errorCode: ErrorCodes.IDEMPOTENCY_CONFLICT,
        });
      }

      return { status: "replay", result: existing.result, statusCode: existing.statusCode };
    },

    async complete(userId, key, { result, statusCode = 200, bodyHash }) {
      await redisClient.set(
        keyFor(userId, key),
        JSON.stringify({ state: "done", bodyHash, result, statusCode }),
        { EX: ttlSeconds },
      );
    },

    /** Release a claim so a genuine retry after a crash is not blocked. */
    async abort(userId, key) {
      await redisClient.del(keyFor(userId, key));
    },
  };
}

/** Rejects unsafe requests that arrive without an Idempotency-Key header. */
export function requireIdempotencyKey(req, res, next) {
  const key = req.headers["idempotency-key"];
  if (!key || typeof key !== "string" || key.length < 8 || key.length > 255) {
    return next(
      new AppError({
        message: "An Idempotency-Key header (8-255 characters) is required for this operation",
        statusCode: 400,
        errorCode: "IDEMPOTENCY_KEY_REQUIRED",
      }),
    );
  }
  req.idempotencyKey = key;
  return next();
}
