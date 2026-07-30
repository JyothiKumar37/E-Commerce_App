import bcrypt from "bcryptjs";
import {
  AppError,
  ErrorCodes,
  TOKEN_AUDIENCE,
  asyncHandler,
  generateRefreshToken,
  hashToken,
  signAccessToken,
  verifyToken,
  withTransaction,
} from "@ecom/shared";
import { config } from "../config.js";
import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";

const REFRESH_COOKIE = "ecom_rt";
const BCRYPT_ROUNDS = 10;

/**
 * A dummy hash with the same cost as a real one. Comparing against it when the
 * email is unknown keeps sign-in timing constant, so an attacker cannot
 * enumerate registered accounts by measuring response latency — which the old
 * implementation allowed by returning 404 immediately for unknown emails.
 */
const DUMMY_HASH = bcrypt.hashSync("timing-equalisation-placeholder", BCRYPT_ROUNDS);

function cookieOptions() {
  return {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: config.COOKIE_SAMESITE,
    // Scoped to the refresh endpoints so the cookie is not attached to every
    // proxied API call. Configurable because the path the browser sees depends
    // on how the API is exposed — see COOKIE_PATH in config.js.
    path: config.COOKIE_PATH,
    maxAge: config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
    ...(config.COOKIE_DOMAIN ? { domain: config.COOKIE_DOMAIN } : {}),
  };
}

function toPublicUser(row) {
  return {
    userId: row.user_id,
    username: row.username,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    role: row.role,
  };
}

async function issueSession(client, user, req, res) {
  const { token: refreshToken, tokenHash } = generateRefreshToken();
  const expiresAt = new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 86_400_000);

  const { rows } = await client.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, user_agent, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING token_id`,
    [user.user_id, tokenHash, (req.headers["user-agent"] ?? "").slice(0, 500), req.ip, expiresAt],
  );

  const accessToken = signAccessToken(
    {
      userId: user.user_id,
      role: user.role,
      email: user.email,
      username: user.username,
    },
    { secret: config.JWT_SECRET, ttl: config.ACCESS_TOKEN_TTL },
  );

  res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions());

  return { accessToken, tokenId: rows[0].token_id };
}

export const signUp = asyncHandler(async (req, res) => {
  const { email, password, username, first_name, last_name } = req.body;

  const result = await withTransaction(pool, async (client) => {
    // Single round trip for both uniqueness checks, and the unique indexes
    // still backstop the race between check and insert.
    const { rows: clashes } = await client.query(
      `SELECT email, username FROM users WHERE email = $1 OR username = $2`,
      [email, username],
    );

    if (clashes.some((r) => r.email.toLowerCase() === email.toLowerCase())) {
      throw new AppError({
        message: "An account with this email already exists.",
        statusCode: 409,
        errorCode: ErrorCodes.EMAIL_TAKEN,
      });
    }
    if (clashes.some((r) => r.username.toLowerCase() === username.toLowerCase())) {
      throw new AppError({
        message: "This username is already taken.",
        statusCode: 409,
        errorCode: ErrorCodes.USERNAME_TAKEN,
      });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    let inserted;
    try {
      ({
        rows: [inserted],
      } = await client.query(
        `INSERT INTO users (username, email, password_hash, first_name, last_name, last_login_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING user_id, username, email, first_name, last_name, role`,
        [username, email, passwordHash, first_name, last_name],
      ));
    } catch (err) {
      if (err.code === "23505") {
        // Lost the race against a concurrent signup.
        throw new AppError({
          message: err.constraint?.includes("username")
            ? "This username is already taken."
            : "An account with this email already exists.",
          statusCode: 409,
          errorCode: err.constraint?.includes("username")
            ? ErrorCodes.USERNAME_TAKEN
            : ErrorCodes.EMAIL_TAKEN,
        });
      }
      throw err;
    }

    const session = await issueSession(client, inserted, req, res);
    return { user: inserted, session };
  });

  logger.info({ userId: result.user.user_id }, "user registered");

  res.status(201).json({
    accessToken: result.session.accessToken,
    expiresIn: config.ACCESS_TOKEN_TTL,
    user: toPublicUser(result.user),
  });
});

export const signIn = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const { rows } = await pool.query(
    `SELECT user_id, username, email, password_hash, first_name, last_name, role, is_active
     FROM users WHERE email = $1`,
    [email],
  );
  const user = rows[0];

  // Always run a bcrypt comparison, even when the user does not exist.
  const passwordMatches = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);

  // One generic message for "no such user" and "wrong password" alike: the old
  // 404 "no user registered with this email" was an account-enumeration oracle.
  if (!user || !passwordMatches) {
    throw new AppError({
      message: "Invalid email or password.",
      statusCode: 401,
      errorCode: ErrorCodes.INVALID_CREDENTIALS,
    });
  }

  if (!user.is_active) {
    throw new AppError({
      message: "This account has been disabled.",
      statusCode: 403,
      errorCode: ErrorCodes.ACCOUNT_DISABLED,
    });
  }

  const session = await withTransaction(pool, async (client) => {
    await client.query("UPDATE users SET last_login_at = NOW() WHERE user_id = $1", [user.user_id]);
    return issueSession(client, user, req, res);
  });

  logger.info({ userId: user.user_id }, "user signed in");

  res.json({
    accessToken: session.accessToken,
    expiresIn: config.ACCESS_TOKEN_TTL,
    user: toPublicUser(user),
  });
});

/**
 * Rotating refresh: the presented token is invalidated and a new one issued.
 *
 * If a token that has *already* been rotated is presented, it was replayed —
 * either by an attacker or by the legitimate user after theft. The entire token
 * family for that user is revoked, forcing a fresh sign-in.
 */
export const refresh = asyncHandler(async (req, res) => {
  const presented = req.cookies?.[REFRESH_COOKIE];
  if (!presented) {
    throw new AppError({
      message: "No refresh token provided.",
      statusCode: 401,
      errorCode: ErrorCodes.INVALID_REFRESH_TOKEN,
    });
  }

  const presentedHash = hashToken(presented);

  const result = await withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT rt.token_id, rt.user_id, rt.expires_at, rt.revoked_at, rt.replaced_by,
              u.username, u.email, u.first_name, u.last_name, u.role, u.is_active
       FROM refresh_tokens rt
       JOIN users u ON u.user_id = rt.user_id
       WHERE rt.token_hash = $1
       FOR UPDATE OF rt`,
      [presentedHash],
    );

    const stored = rows[0];
    if (!stored) {
      throw new AppError({
        message: "Invalid refresh token.",
        statusCode: 401,
        errorCode: ErrorCodes.INVALID_REFRESH_TOKEN,
      });
    }

    if (stored.replaced_by || stored.revoked_at) {
      // Reuse of a rotated token means it was stolen (or the legitimate holder
      // is racing themselves). The whole family must be revoked — but the
      // revocation cannot happen here: throwing out of `withTransaction` rolls
      // the statement back, so the detection would log a warning and revoke
      // nothing. Report it upward and let the caller revoke after commit.
      return { outcome: "reuse", userId: stored.user_id };
    }

    if (new Date(stored.expires_at) <= new Date()) {
      throw new AppError({
        message: "Session has expired. Please sign in again.",
        statusCode: 401,
        errorCode: ErrorCodes.EXPIRED_TOKEN,
      });
    }

    if (!stored.is_active) {
      throw new AppError({
        message: "This account has been disabled.",
        statusCode: 403,
        errorCode: ErrorCodes.ACCOUNT_DISABLED,
      });
    }

    const user = {
      user_id: stored.user_id,
      username: stored.username,
      email: stored.email,
      first_name: stored.first_name,
      last_name: stored.last_name,
      role: stored.role,
    };

    const session = await issueSession(client, user, req, res);

    await client.query(
      `UPDATE refresh_tokens SET revoked_at = NOW(), replaced_by = $2 WHERE token_id = $1`,
      [stored.token_id, session.tokenId],
    );

    return { outcome: "rotated", user, session };
  });

  // Runs after the transaction has committed and released its row locks, so
  // the revocation actually persists.
  if (result.outcome === "reuse") {
    const { rowCount } = await pool.query(
      `UPDATE refresh_tokens SET revoked_at = NOW()
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [result.userId],
    );
    logger.warn(
      { userId: result.userId, revoked: rowCount },
      "refresh token reuse detected; session family revoked",
    );
    res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(), maxAge: undefined });
    throw new AppError({
      message: "Session is no longer valid. Please sign in again.",
      statusCode: 401,
      errorCode: ErrorCodes.INVALID_REFRESH_TOKEN,
    });
  }

  res.json({
    accessToken: result.session.accessToken,
    expiresIn: config.ACCESS_TOKEN_TTL,
    user: toPublicUser(result.user),
  });
});

export const signOut = asyncHandler(async (req, res) => {
  const presented = req.cookies?.[REFRESH_COOKIE];

  if (presented) {
    await pool.query(
      `UPDATE refresh_tokens SET revoked_at = NOW()
       WHERE token_hash = $1 AND revoked_at IS NULL`,
      [hashToken(presented)],
    );
  }

  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(), maxAge: undefined });
  res.status(204).end();
});

/** Revokes every session for the current user ("sign out everywhere"). */
export const signOutAll = asyncHandler(async (req, res) => {
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = NOW()
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [req.auth.userId],
  );
  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(), maxAge: undefined });
  res.status(204).end();
});

/** Lets the SPA hydrate its auth state without decoding the JWT client-side. */
export const me = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT user_id, username, email, first_name, last_name, role
     FROM users WHERE user_id = $1 AND is_active`,
    [req.auth.userId],
  );
  if (!rows[0]) {
    throw new AppError({
      message: "User not found.",
      statusCode: 404,
      errorCode: ErrorCodes.USER_NOT_FOUND,
    });
  }
  res.json({ user: toPublicUser(rows[0]) });
});

/** Exposed for tests: verifies an access token minted by this gateway. */
export const verifyAccessToken = (token) =>
  verifyToken(token, { secret: config.JWT_SECRET, audience: TOKEN_AUDIENCE.CLIENT });
