import rateLimit from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { ErrorCodes } from "./errors.js";

/**
 * Collapses an IPv6 address to its /64 prefix before using it as a bucket key.
 *
 * ISPs routinely hand a single customer a /64 (or larger), so keying on the
 * full address would let one client cycle through 2^64 addresses and get an
 * unlimited quota. IPv4 addresses are used as-is.
 */
export function normaliseIp(ip) {
  if (!ip) return "unknown";

  // Express reports IPv4-mapped IPv6 as "::ffff:1.2.3.4".
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];

  if (!ip.includes(":")) return ip;

  // Expand "::" so the first four hextets can be taken reliably.
  const [head, tail = ""] = ip.split("::");
  const headParts = head ? head.split(":").filter(Boolean) : [];
  const tailParts = tail ? tail.split(":").filter(Boolean) : [];
  const missing = 8 - headParts.length - tailParts.length;
  const full = ip.includes("::")
    ? [...headParts, ...Array(Math.max(missing, 0)).fill("0"), ...tailParts]
    : ip.split(":");

  return `${full.slice(0, 4).join(":")}::/64`;
}

/**
 * Rate limiter backed by Redis so limits are enforced across gateway replicas
 * (an in-memory limiter lets an attacker multiply their quota by the number of
 * instances). Falls back to in-memory when no Redis client is supplied.
 */
/**
 * Chooses the backing store.
 *
 * `RedisStore` issues a SCRIPT LOAD from its own constructor, so handing it a
 * client that is not yet open throws synchronously. Services connect Redis in
 * their entrypoint before building the app, so in production this always takes
 * the Redis path; the in-memory fallback exists so the app can still be
 * constructed offline — by tests, by the smoke check, and by a boot sequence
 * where Redis has not come up yet.
 */
function buildStore(redisClient, prefix, logger) {
  if (!redisClient) return undefined;

  if (!redisClient.isOpen) {
    logger?.warn(
      { prefix },
      "redis is not connected; rate limiting falls back to per-instance memory " +
        "and will not be shared across replicas",
    );
    return undefined;
  }

  return new RedisStore({
    prefix,
    sendCommand: (...args) => redisClient.sendCommand(args),
  });
}

export function createRateLimiter({
  redisClient,
  windowMs = 60_000,
  max = 100,
  prefix = "rl:",
  keyBy = "ip",
  logger,
  message = "Too many requests, please try again later",
} = {}) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    // Authenticated callers get a per-user quota; anonymous ones per-IP,
    // collapsed to a /64 so an IPv6 allocation cannot be used to evade.
    keyGenerator: (req) => {
      if (keyBy === "user" && req.auth?.userId) return `u:${req.auth.userId}`;
      return `i:${normaliseIp(req.ip)}`;
    },
    skip: (req) => req.method === "OPTIONS" || req.path === "/healthz" || req.path === "/readyz",
    store: buildStore(redisClient, prefix, logger),
    handler: (req, res) => {
      res.status(429).json({
        error: {
          message,
          errorType: "TooManyRequests",
          errorCode: ErrorCodes.RATE_LIMITED,
          statusCode: 429,
          requestId: req.id,
        },
      });
    },
  });
}

/** Tight limiter for credential endpoints, keyed by IP + submitted email. */
export function createAuthRateLimiter({
  redisClient,
  windowMs = 15 * 60_000,
  max = 10,
  logger,
} = {}) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skipSuccessfulRequests: true, // only failed attempts count toward lockout
    keyGenerator: (req) => {
      const email = typeof req.body?.email === "string" ? req.body.email.toLowerCase() : "";
      return `auth:${normaliseIp(req.ip)}:${email}`;
    },
    store: buildStore(redisClient, "rl:auth:", logger),
    handler: (req, res) => {
      res.status(429).json({
        error: {
          message: "Too many failed attempts. Please try again in a few minutes.",
          errorType: "TooManyRequests",
          errorCode: ErrorCodes.RATE_LIMITED,
          statusCode: 429,
          requestId: req.id,
        },
      });
    },
  });
}
