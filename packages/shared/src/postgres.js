import pg from "pg";
import { AppError, ErrorCodes } from "./errors.js";

const { Pool, types } = pg;

// Return BIGINT and NUMERIC as JS numbers/strings we can reason about rather
// than driver-specific objects. Money is stored as integer cents, so BIGINT ->
// Number is safe here (well within 2^53).
types.setTypeParser(types.builtins.INT8, (v) => (v === null ? null : Number(v)));
types.setTypeParser(types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));

/**
 * Creates a pool with sane production defaults and a real TLS policy.
 *
 * The previous pools hardcoded `ssl: { rejectUnauthorized: false }`, which
 * accepts any certificate and defeats the point of TLS. TLS is now driven by
 * `PGSSLMODE`: `disable` for local Docker, `require` for managed Postgres with
 * a CA bundle supplied via `PGSSLROOTCERT`.
 */
export function createPool({ connectionString, ssl, max = 10, logger } = {}) {
  const pool = new Pool({
    connectionString,
    ssl: ssl ?? resolveSsl(),
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Fail fast instead of hanging a request behind a wedged connection.
    statement_timeout: 15_000,
    query_timeout: 15_000,
    application_name: process.env.SERVICE_NAME ?? "ecom",
  });

  // An idle client erroring must not take the process down.
  pool.on("error", (err) => {
    logger?.error({ err: { message: err.message, code: err.code } }, "idle postgres client error");
  });

  return pool;
}

function resolveSsl() {
  const mode = (process.env.PGSSLMODE ?? "disable").toLowerCase();
  if (mode === "disable") return false;

  const ca = process.env.PGSSLROOTCERT;
  if (mode === "no-verify") {
    // Explicit, opt-in, and never the default.
    return { rejectUnauthorized: false };
  }
  return {
    rejectUnauthorized: true,
    ...(ca ? { ca } : {}),
  };
}

/** Readiness probe target. */
export async function checkConnection(pool) {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch (err) {
    throw new AppError({
      message: "Database unavailable",
      statusCode: 503,
      errorCode: ErrorCodes.DB_UNAVAILABLE,
      cause: err,
    });
  }
}

/**
 * Runs `fn` inside a transaction, rolling back on any throw and always
 * releasing the client. Order placement, inventory reservation and payment
 * capture all depend on this.
 */
export async function withTransaction(pool, fn, { isolationLevel } = {}) {
  const client = await pool.connect();
  try {
    await client.query(isolationLevel ? `BEGIN ISOLATION LEVEL ${isolationLevel}` : "BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* connection already broken; nothing to salvage */
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Retries a transaction on serialization failures and deadlocks. Concurrent
 * checkouts contending for the same inventory row hit these routinely.
 */
export async function withRetryableTransaction(pool, fn, { retries = 3, ...opts } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await withTransaction(pool, fn, opts);
    } catch (err) {
      lastError = err;
      const retryable = err?.code === "40001" || err?.code === "40P01";
      if (!retryable || attempt === retries) throw err;
      await sleep(2 ** attempt * 25 + Math.random() * 25);
    }
  }
  throw lastError;
}

/** Builds a parameterised `SET` clause from a partial patch object. */
export function buildUpdateSet(patch, startIndex = 1) {
  const columns = Object.keys(patch).filter((k) => patch[k] !== undefined);
  const clause = columns
    .map((column, i) => `${quoteIdent(column)} = $${startIndex + i}`)
    .join(", ");
  const values = columns.map((column) => patch[column]);
  return { clause, values, columns, nextIndex: startIndex + columns.length };
}

/**
 * Identifiers cannot be parameterised, so any column name interpolated into
 * SQL must be an exact match against a known-safe pattern.
 */
function quoteIdent(name) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new AppError({
      message: `Unsafe column identifier: ${name}`,
      statusCode: 500,
      errorCode: "DB_UNSAFE_IDENTIFIER",
    });
  }
  return `"${name}"`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
