/**
 * Refresh-token rotation and theft detection.
 *
 * Running the stack exposed a bug that no unit test caught: the reuse branch
 * issued its `UPDATE … SET revoked_at` from inside `withTransaction` and then
 * threw, so the rollback undid the revocation. Detection logged a warning and
 * revoked nothing — a stolen token kept working indefinitely.
 *
 * These tests drive the real controller against a stub pool that records every
 * statement, so the ordering (commit, then revoke) is asserted rather than
 * assumed. No database required.
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

process.env.NODE_ENV = "test";
process.env.INTERNAL_JWT_SECRET ??= "test-internal-secret-at-least-32-chars-long";
process.env.JWT_SECRET ??= "test-client-secret-at-least-32-characters!!";
process.env.DATABASE_URL ??= "postgres://ecom:ecom@localhost:5432/ecom";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.CORS_ORIGINS ??= "http://localhost:5173";
process.env.LOG_LEVEL = "fatal";
for (const [key, port] of Object.entries({
  ACCOUNT_SERVICE_URL: 8081,
  CART_SERVICE_URL: 8082,
  INVENTORY_SERVICE_URL: 8083,
  ORDER_STATUS_SERVICE_URL: 8084,
  PAYMENT_SERVICE_URL: 8085,
  PLACE_ORDER_SERVICE_URL: 8086,
  PRODUCT_REVIEW_SERVICE_URL: 8087,
  RECOMMENDATION_SERVICE_URL: 8088,
  RECOMMENDATION_GENERATION_SERVICE_URL: 8089,
  SEARCH_SERVICE_URL: 8090,
  SHIPPING_SERVICE_URL: 8091,
})) {
  process.env[key] ??= `http://localhost:${port}`;
}

let refresh;
let pool;
let hashToken;

before(async () => {
  ({ pool } = await import("../src/lib/db.js"));
  ({ refresh } = await import("../src/controllers/authController.js"));
  ({ hashToken } = await import("@ecom/shared"));
});

/**
 * Replaces the pool's query surface with a scripted stub that logs statements.
 * `rowsFor` maps a substring of the SQL to the rows it should return.
 */
function stubPool(rowsFor) {
  const log = [];

  const respond = (sql, params) => {
    log.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
    for (const [needle, rows] of Object.entries(rowsFor)) {
      if (sql.includes(needle)) {
        return { rows: typeof rows === "function" ? rows(params) : rows, rowCount: 1 };
      }
    }
    return { rows: [], rowCount: 0 };
  };

  const client = { query: async (sql, params) => respond(sql, params), release() {} };

  const originalConnect = pool.connect;
  const originalQuery = pool.query;

  pool.connect = async () => client;
  pool.query = async (sql, params) => respond(sql, params);

  return {
    log,
    restore() {
      pool.connect = originalConnect;
      pool.query = originalQuery;
    },
  };
}

const fakeRes = () => ({
  statusCode: 200,
  body: null,
  cookies: [],
  cleared: [],
  cookie(name, value, opts) {
    this.cookies.push({ name, value, opts });
    return this;
  },
  clearCookie(name) {
    this.cleared.push(name);
    return this;
  },
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  },
});

const reqWith = (token) => ({
  cookies: { ecom_rt: token },
  headers: { "user-agent": "test" },
  ip: "127.0.0.1",
});

/**
 * Resolves with the error passed to `next`, or `undefined` if the handler
 * responded successfully. The success path never calls `next`, so waiting on
 * the handler's own promise is what completes the run.
 */
async function run(handler, req, res) {
  let viaNext;
  const nextCalled = new Promise((resolve) => {
    viaNext = resolve;
  });

  // Whichever happens first wins: `next(err)` on the failure path, or the
  // handler's own promise settling on the success path.
  const viaReturn = Promise.resolve(handler(req, res, viaNext)).then(
    () => undefined,
    (err) => err,
  );

  return Promise.race([nextCalled, viaReturn]);
}

describe("refresh rotation", () => {
  it("rotates a valid token and revokes the presented one", async () => {
    const stub = stubPool({
      "FROM refresh_tokens rt": [
        {
          token_id: "tok-1",
          user_id: "user-1",
          expires_at: new Date(Date.now() + 86_400_000),
          revoked_at: null,
          replaced_by: null,
          username: "demo",
          email: "demo@example.com",
          first_name: "Demo",
          last_name: "User",
          role: "customer",
          is_active: true,
        },
      ],
      "INSERT INTO refresh_tokens": [{ token_id: "tok-2" }],
    });

    try {
      const res = fakeRes();
      const err = await run(refresh, reqWith("plaintext-token"), res);

      assert.equal(err, undefined, `unexpected error: ${err?.message}`);
      assert.ok(res.body?.accessToken, "should return a new access token");

      // The presented token must be marked replaced, pointing at its successor.
      const rotation = stub.log.find((q) => q.sql.includes("SET revoked_at = NOW(), replaced_by"));
      assert.ok(rotation, "presented token was not rotated");
      assert.deepEqual(rotation.params, ["tok-1", "tok-2"]);

      // A fresh cookie must be issued.
      assert.equal(res.cookies.at(-1)?.name, "ecom_rt");
    } finally {
      stub.restore();
    }
  });

  it("revokes the entire family when a rotated token is replayed", async () => {
    const stub = stubPool({
      "FROM refresh_tokens rt": [
        {
          token_id: "tok-1",
          user_id: "user-1",
          expires_at: new Date(Date.now() + 86_400_000),
          revoked_at: new Date(),
          // Already rotated: presenting it again means it was stolen.
          replaced_by: "tok-2",
          username: "demo",
          email: "demo@example.com",
          first_name: "Demo",
          last_name: "User",
          role: "customer",
          is_active: true,
        },
      ],
    });

    try {
      const res = fakeRes();
      const err = await run(refresh, reqWith("stolen-token"), res);

      assert.ok(err, "reuse must be rejected");
      assert.equal(err.statusCode, 401);
      assert.equal(err.errorCode, "AUTH_INVALID_REFRESH_TOKEN");

      const revokeAll = stub.log.filter((q) =>
        q.sql.includes("SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL"),
      );
      assert.equal(revokeAll.length, 1, "the family revocation must be issued exactly once");
      assert.deepEqual(revokeAll[0].params, ["user-1"]);

      // The revocation must come AFTER COMMIT. Issued inside the transaction it
      // would be rolled back by the throw, which is the bug this guards.
      const commitIndex = stub.log.findIndex((q) => q.sql === "COMMIT");
      const revokeIndex = stub.log.indexOf(revokeAll[0]);
      assert.ok(commitIndex >= 0, "the transaction should have committed");
      assert.ok(
        revokeIndex > commitIndex,
        `revocation at ${revokeIndex} must follow COMMIT at ${commitIndex}, or the rollback undoes it`,
      );

      assert.ok(res.cleared.includes("ecom_rt"), "the stolen cookie should be cleared");
    } finally {
      stub.restore();
    }
  });

  it("rejects an expired token without revoking the family", async () => {
    const stub = stubPool({
      "FROM refresh_tokens rt": [
        {
          token_id: "tok-1",
          user_id: "user-1",
          expires_at: new Date(Date.now() - 1000),
          revoked_at: null,
          replaced_by: null,
          username: "demo",
          email: "demo@example.com",
          first_name: "Demo",
          last_name: "User",
          role: "customer",
          is_active: true,
        },
      ],
    });

    try {
      const err = await run(refresh, reqWith("stale-token"), fakeRes());

      assert.equal(err.statusCode, 401);
      assert.equal(err.errorCode, "AUTH_EXPIRED_TOKEN");
      // Natural expiry is not theft; other sessions must survive.
      assert.equal(
        stub.log.filter((q) => q.sql.includes("AND revoked_at IS NULL")).length,
        0,
        "expiry must not revoke the whole family",
      );
    } finally {
      stub.restore();
    }
  });

  it("rejects an unknown token", async () => {
    const stub = stubPool({});
    try {
      const err = await run(refresh, reqWith("never-issued"), fakeRes());
      assert.equal(err.statusCode, 401);
      assert.equal(err.errorCode, "AUTH_INVALID_REFRESH_TOKEN");
    } finally {
      stub.restore();
    }
  });

  it("rejects a request with no cookie at all", async () => {
    const err = await run(refresh, { cookies: {}, headers: {}, ip: "127.0.0.1" }, fakeRes());
    assert.equal(err.statusCode, 401);
  });

  it("looks the token up by digest, never by plaintext", async () => {
    const stub = stubPool({});
    try {
      await run(refresh, reqWith("plaintext-token"), fakeRes());

      const lookup = stub.log.find((q) => q.sql.includes("WHERE rt.token_hash = $1"));
      assert.ok(lookup, "lookup should be by token_hash");
      assert.equal(lookup.params[0], hashToken("plaintext-token"));
      assert.notEqual(lookup.params[0], "plaintext-token");
    } finally {
      stub.restore();
    }
  });
});
