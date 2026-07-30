import bcrypt from "bcryptjs";
import { AppError, ErrorCodes, asyncHandler, buildUpdateSet, withTransaction } from "@ecom/shared";
import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";

const BCRYPT_ROUNDS = 10;

const toPublicUser = (row) => ({
  userId: row.user_id,
  username: row.username,
  email: row.email,
  firstName: row.first_name,
  lastName: row.last_name,
  role: row.role,
  createdAt: row.created_at,
  lastLoginAt: row.last_login_at,
});

export const getUser = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT user_id, username, email, first_name, last_name, role, created_at, last_login_at
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

export const updateUser = asyncHandler(async (req, res) => {
  const userId = req.auth.userId;
  const { username, email, first_name, last_name } = req.body;

  const updated = await withTransaction(pool, async (client) => {
    const { rows: existing } = await client.query(
      `SELECT user_id FROM users WHERE user_id = $1 AND is_active FOR UPDATE`,
      [userId],
    );
    if (!existing[0]) {
      throw new AppError({
        message: "User not found.",
        statusCode: 404,
        errorCode: ErrorCodes.USER_NOT_FOUND,
      });
    }

    if (email || username) {
      const { rows: clashes } = await client.query(
        `SELECT email, username FROM users
         WHERE user_id <> $1 AND (email = $2 OR username = $3)`,
        [userId, email ?? null, username ?? null],
      );
      if (email && clashes.some((r) => r.email.toLowerCase() === email.toLowerCase())) {
        throw new AppError({
          message: "An account with this email already exists.",
          statusCode: 409,
          errorCode: ErrorCodes.EMAIL_TAKEN,
        });
      }
      if (username && clashes.some((r) => r.username.toLowerCase() === username.toLowerCase())) {
        throw new AppError({
          message: "This username is already taken.",
          statusCode: 409,
          errorCode: ErrorCodes.USERNAME_TAKEN,
        });
      }
    }

    // Column names come from `buildUpdateSet`, which validates each identifier
    // against a strict pattern before interpolating it. The old code
    // concatenated the SET clause by hand with ad-hoc comma bookkeeping.
    const { clause, values, nextIndex } = buildUpdateSet({
      username,
      email,
      first_name,
      last_name,
    });

    const { rows } = await client.query(
      `UPDATE users SET ${clause}
       WHERE user_id = $${nextIndex}
       RETURNING user_id, username, email, first_name, last_name, role, created_at, last_login_at`,
      [...values, userId],
    );

    return rows[0];
  });

  logger.info({ userId }, "profile updated");
  res.json({ user: toPublicUser(updated), message: "Profile updated." });
});

/**
 * Changing a password proves knowledge of the old one and revokes every other
 * session. Token re-issue is the gateway's job — this service has no access to
 * the client-facing signing key, which is precisely why the old `editUser`
 * could not mint a valid token here (it signed `{ _id: user.id }` against a
 * column named `user_id`, producing a token with `sub: undefined`).
 */
export const changePassword = asyncHandler(async (req, res) => {
  const userId = req.auth.userId;
  const { currentPassword, newPassword } = req.body;

  await withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT password_hash FROM users WHERE user_id = $1 AND is_active FOR UPDATE`,
      [userId],
    );
    if (!rows[0]) {
      throw new AppError({
        message: "User not found.",
        statusCode: 404,
        errorCode: ErrorCodes.USER_NOT_FOUND,
      });
    }

    const matches = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!matches) {
      throw new AppError({
        message: "Your current password is incorrect.",
        statusCode: 401,
        errorCode: ErrorCodes.INVALID_CREDENTIALS,
      });
    }

    if (await bcrypt.compare(newPassword, rows[0].password_hash)) {
      throw new AppError({
        message: "New password must differ from the current one.",
        statusCode: 400,
        errorCode: ErrorCodes.VALIDATION_FAILED,
      });
    }

    // Same cost factor as registration. The old edit path silently re-hashed
    // at cost 5 while signup used 10, quietly weakening every changed password.
    const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await client.query("UPDATE users SET password_hash = $1 WHERE user_id = $2", [hash, userId]);

    await client.query(
      "UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL",
      [userId],
    );
  });

  logger.info({ userId }, "password changed; all sessions revoked");
  res.json({ message: "Password updated. Please sign in again." });
});

export const deleteUser = asyncHandler(async (req, res) => {
  const userId = req.auth.userId;
  const { password } = req.body;

  await withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT password_hash FROM users WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    if (!rows[0]) {
      throw new AppError({
        message: "User not found.",
        statusCode: 404,
        errorCode: ErrorCodes.USER_NOT_FOUND,
      });
    }

    // Deletion is irreversible; require the password rather than just a token.
    if (!(await bcrypt.compare(password, rows[0].password_hash))) {
      throw new AppError({
        message: "Password is incorrect.",
        statusCode: 401,
        errorCode: ErrorCodes.INVALID_CREDENTIALS,
      });
    }

    const { rows: openOrders } = await client.query(
      `SELECT COUNT(*)::int AS count FROM orders
       WHERE user_id = $1 AND status IN ('pending_payment', 'paid', 'processing', 'shipped')`,
      [userId],
    );
    if (openOrders[0].count > 0) {
      throw new AppError({
        message: `You have ${openOrders[0].count} order(s) in progress. Accounts cannot be deleted until they complete.`,
        statusCode: 409,
        errorCode: "ACCOUNT_HAS_OPEN_ORDERS",
      });
    }

    // Soft delete: `orders.user_id` is ON DELETE RESTRICT because financial
    // records must survive. Anonymise the identity instead of destroying it.
    await client.query(
      `UPDATE users
       SET is_active     = FALSE,
           email         = 'deleted+' || user_id || '@invalid',
           username      = 'deleted_' || REPLACE(user_id::text, '-', ''),
           first_name    = 'Deleted',
           last_name     = 'User',
           password_hash = ''
       WHERE user_id = $1`,
      [userId],
    );
    await client.query("DELETE FROM addresses WHERE user_id = $1", [userId]);
    await client.query("UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1", [userId]);
  });

  logger.info({ userId }, "account deleted");
  res.json({ message: "Your account has been deleted." });
});
