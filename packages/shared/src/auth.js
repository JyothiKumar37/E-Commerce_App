import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";
import { AppError, ErrorCodes } from "./errors.js";

/**
 * Canonical token contract for the whole platform.
 *
 * Historically the gateway signed `{ id }`, its own middleware read `id`, the
 * account service read `_id`, and `editUser` signed `{ _id: user.id }` against
 * a column actually named `user_id`. Three mutually incompatible claim names
 * meant every authenticated account route ran with `userId === undefined`.
 *
 * There is now exactly one place that mints tokens and one that reads them,
 * and the claim is the registered `sub`.
 */
export const TOKEN_AUDIENCE = {
  CLIENT: "ecom:client",
  INTERNAL: "ecom:internal",
};

export const TOKEN_ISSUER = "ecom:api-gateway";

/** Access token handed to browsers. Short-lived; refresh rotates it. */
export function signAccessToken(
  { userId, role = "customer", email, username },
  { secret, ttl = "15m" },
) {
  assertSecret(secret);
  return jwt.sign({ role, email, username, typ: "access" }, secret, {
    subject: String(userId),
    issuer: TOKEN_ISSUER,
    audience: TOKEN_AUDIENCE.CLIENT,
    expiresIn: ttl,
    algorithm: "HS256",
  });
}

/**
 * Internal token minted by the gateway for one downstream hop.
 *
 * The client's own token never reaches a service. The old proxy tried to strip
 * it with `delete config.headers["Authorization"]`, but Node lowercases inbound
 * header names, so the delete never matched and the client JWT was forwarded
 * verbatim. Here the outbound header set is built from scratch rather than
 * copied, so there is nothing to strip.
 */
export function signInternalToken({ userId, role = "customer", actor }, { secret, ttl = 60 }) {
  assertSecret(secret);
  return jwt.sign({ role, actor, typ: "internal" }, secret, {
    subject: userId ? String(userId) : "anonymous",
    issuer: TOKEN_ISSUER,
    audience: TOKEN_AUDIENCE.INTERNAL,
    expiresIn: ttl,
    algorithm: "HS256",
  });
}

export function verifyToken(token, { secret, audience }) {
  assertSecret(secret);
  try {
    return jwt.verify(token, secret, {
      algorithms: ["HS256"], // pinned: never let the token pick `none`
      issuer: TOKEN_ISSUER,
      audience,
    });
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw new AppError({
        message: "Token has expired",
        statusCode: 401,
        errorCode: ErrorCodes.EXPIRED_TOKEN,
      });
    }
    throw new AppError({
      message: "Invalid token",
      statusCode: 401,
      errorCode: ErrorCodes.INVALID_TOKEN,
    });
  }
}

/**
 * Extracts a bearer token. The old middleware read the raw header value with
 * no scheme, so `Authorization: Bearer <jwt>` — what every HTTP client sends —
 * failed to verify. Both forms are accepted now, with `Bearer` preferred.
 */
export function extractBearer(req) {
  const header = req.headers?.authorization;
  if (!header || typeof header !== "string") return null;
  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (rest.length === 0) return scheme || null; // bare token, legacy clients
  if (!/^Bearer$/i.test(scheme)) return null;
  return rest.join(" ") || null;
}

/**
 * Guard factory. `audience` decides whether this endpoint trusts client tokens
 * (the gateway) or internal tokens (every downstream service).
 */
export function requireAuth({ secret, audience = TOKEN_AUDIENCE.INTERNAL, optional = false }) {
  return (req, res, next) => {
    const token = extractBearer(req);

    if (!token) {
      if (optional) {
        req.auth = null;
        return next();
      }
      return next(
        new AppError({
          message: "Authentication required",
          statusCode: 401,
          errorCode: ErrorCodes.MISSING_TOKEN,
        }),
      );
    }

    try {
      const claims = verifyToken(token, { secret, audience });
      if (optional && claims.sub === "anonymous") {
        req.auth = null;
        return next();
      }
      req.auth = {
        userId: claims.sub,
        role: claims.role ?? "customer",
        email: claims.email,
        username: claims.username,
        claims,
      };
      return next();
    } catch (err) {
      if (optional) {
        req.auth = null;
        return next();
      }
      return next(err);
    }
  };
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.auth) {
      return next(
        new AppError({
          message: "Authentication required",
          statusCode: 401,
          errorCode: ErrorCodes.MISSING_TOKEN,
        }),
      );
    }
    if (!roles.includes(req.auth.role)) {
      return next(
        new AppError({
          message: "You do not have permission to perform this action",
          statusCode: 403,
          errorCode: ErrorCodes.FORBIDDEN,
        }),
      );
    }
    return next();
  };
}

/* ------------------------------------------------------------------ *
 * Refresh tokens
 *
 * Opaque random strings, never JWTs: they must be revocable. Only the
 * SHA-256 digest is stored, so a database dump cannot be replayed.
 * ------------------------------------------------------------------ */

export function generateRefreshToken() {
  const token = randomBytes(48).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function assertSecret(secret) {
  if (!secret || typeof secret !== "string" || secret.length < 32) {
    throw new AppError({
      message: "Server misconfiguration: JWT secret missing or too short",
      statusCode: 500,
      errorCode: "CONFIG_INVALID_SECRET",
    });
  }
}
