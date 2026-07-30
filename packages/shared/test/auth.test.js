import assert from "node:assert/strict";
import { describe, it } from "node:test";
import jwt from "jsonwebtoken";
import {
  TOKEN_AUDIENCE,
  extractBearer,
  generateRefreshToken,
  hashToken,
  requireAuth,
  requireRole,
  signAccessToken,
  signInternalToken,
  verifyToken,
} from "../src/auth.js";

const SECRET = "test-secret-that-is-at-least-32-characters-long";
const OTHER_SECRET = "a-different-secret-also-32-characters-long!!";

describe("token claims", () => {
  it("puts the user id in `sub`, the one claim every verifier reads", () => {
    const token = signAccessToken({ userId: "user-1", role: "customer" }, { secret: SECRET });
    const claims = verifyToken(token, { secret: SECRET, audience: TOKEN_AUDIENCE.CLIENT });

    assert.equal(claims.sub, "user-1");
    assert.equal(claims.role, "customer");
  });

  it("round-trips a signed access token through requireAuth", () => {
    const token = signAccessToken({ userId: "user-1", role: "admin" }, { secret: SECRET });
    const req = { headers: { authorization: `Bearer ${token}` } };

    let called = false;
    requireAuth({ secret: SECRET, audience: TOKEN_AUDIENCE.CLIENT })(req, {}, (err) => {
      assert.equal(err, undefined);
      called = true;
    });

    assert.ok(called);
    assert.equal(req.auth.userId, "user-1");
    assert.equal(req.auth.role, "admin");
  });

  it("rejects a client token presented to a service expecting an internal token", () => {
    // The original bug class: the gateway forwarded the browser's own JWT and
    // downstream services accepted it. Audience separation makes that fail.
    const clientToken = signAccessToken({ userId: "user-1" }, { secret: SECRET });

    assert.throws(
      () => verifyToken(clientToken, { secret: SECRET, audience: TOKEN_AUDIENCE.INTERNAL }),
      /Invalid token/,
    );
  });

  it("rejects a token signed with a different secret", () => {
    const token = signAccessToken({ userId: "user-1" }, { secret: OTHER_SECRET });

    assert.throws(
      () => verifyToken(token, { secret: SECRET, audience: TOKEN_AUDIENCE.CLIENT }),
      /Invalid token/,
    );
  });

  it("refuses the `none` algorithm", () => {
    const forged = jwt.sign({ sub: "attacker", role: "admin" }, "", {
      algorithm: "none",
      issuer: "ecom:api-gateway",
      audience: TOKEN_AUDIENCE.CLIENT,
    });

    assert.throws(
      () => verifyToken(forged, { secret: SECRET, audience: TOKEN_AUDIENCE.CLIENT }),
      /Invalid token/,
    );
  });

  it("reports an expired token distinctly, so the client knows to refresh", () => {
    const expired = signAccessToken({ userId: "user-1" }, { secret: SECRET, ttl: "-1s" });

    assert.throws(
      () => verifyToken(expired, { secret: SECRET, audience: TOKEN_AUDIENCE.CLIENT }),
      (err) => err.errorCode === "AUTH_EXPIRED_TOKEN",
    );
  });

  it("refuses to sign with a secret shorter than 32 characters", () => {
    assert.throws(
      () => signAccessToken({ userId: "u" }, { secret: "short" }),
      /secret missing or too short/,
    );
  });

  it("mints internal tokens with the internal audience and a short TTL", () => {
    const token = signInternalToken(
      { userId: "user-1", actor: "gateway" },
      { secret: SECRET, ttl: 60 },
    );
    const claims = verifyToken(token, { secret: SECRET, audience: TOKEN_AUDIENCE.INTERNAL });

    assert.equal(claims.sub, "user-1");
    assert.equal(claims.actor, "gateway");
    assert.ok(claims.exp - claims.iat <= 60);
  });
});

describe("extractBearer", () => {
  it("accepts the standard Bearer scheme", () => {
    assert.equal(
      extractBearer({ headers: { authorization: "Bearer abc.def.ghi" } }),
      "abc.def.ghi",
    );
  });

  it("is case-insensitive about the scheme", () => {
    assert.equal(extractBearer({ headers: { authorization: "bearer abc" } }), "abc");
  });

  it("still accepts a bare token, as the original clients sent", () => {
    assert.equal(extractBearer({ headers: { authorization: "abc.def.ghi" } }), "abc.def.ghi");
  });

  it("rejects an unknown scheme rather than treating it as a token", () => {
    assert.equal(extractBearer({ headers: { authorization: "Basic dXNlcjpwYXNz" } }), null);
  });

  it("returns null when the header is absent", () => {
    assert.equal(extractBearer({ headers: {} }), null);
  });
});

describe("requireAuth", () => {
  it("401s when no credential is supplied", () => {
    let error;
    requireAuth({ secret: SECRET })({ headers: {} }, {}, (err) => {
      error = err;
    });

    assert.equal(error.statusCode, 401);
    assert.equal(error.errorCode, "AUTH_MISSING_TOKEN");
  });

  it("lets anonymous callers through when optional", () => {
    const req = { headers: {} };
    let called = false;

    requireAuth({ secret: SECRET, optional: true })(req, {}, (err) => {
      assert.equal(err, undefined);
      called = true;
    });

    assert.ok(called);
    assert.equal(req.auth, null);
  });

  it("treats an invalid token as anonymous when optional, not as an error", () => {
    const req = { headers: { authorization: "Bearer garbage" } };
    let error = "unset";

    requireAuth({ secret: SECRET, optional: true })(req, {}, (err) => {
      error = err;
    });

    assert.equal(error, undefined);
    assert.equal(req.auth, null);
  });
});

describe("requireRole", () => {
  it("403s a customer attempting an admin action", () => {
    const req = { auth: { userId: "u", role: "customer" } };
    let error;

    requireRole("admin")(req, {}, (err) => {
      error = err;
    });

    assert.equal(error.statusCode, 403);
    assert.equal(error.errorCode, "AUTH_FORBIDDEN");
  });

  it("allows a matching role", () => {
    const req = { auth: { userId: "u", role: "admin" } };
    let error = "unset";

    requireRole("admin")(req, {}, (err) => {
      error = err;
    });

    assert.equal(error, undefined);
  });

  it("401s when there is no identity at all", () => {
    let error;
    requireRole("admin")({ auth: null }, {}, (err) => {
      error = err;
    });
    assert.equal(error.statusCode, 401);
  });
});

describe("refresh tokens", () => {
  it("generates a high-entropy token and stores only its digest", () => {
    const { token, tokenHash } = generateRefreshToken();

    assert.ok(token.length >= 64);
    assert.equal(tokenHash, hashToken(token));
    // The digest must not contain the token itself.
    assert.ok(!tokenHash.includes(token));
  });

  it("produces a different token every call", () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    assert.notEqual(a.token, b.token);
  });
});
