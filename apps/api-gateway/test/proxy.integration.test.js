/**
 * Real HTTP integration test for the reverse proxy.
 *
 * A stub upstream is started on an ephemeral port and echoes back exactly what
 * it received, so these assertions are about wire behaviour rather than mocks.
 * This is where the original code's worst bugs lived: the client's JWT leaking
 * to upstreams, the query string being appended twice, and upstream error
 * detail being flattened away.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import express from "express";

process.env.NODE_ENV = "test";
process.env.INTERNAL_JWT_SECRET = "integration-internal-secret-32-chars-min!";
process.env.JWT_SECRET = "integration-client-secret-32-chars-minimum";
process.env.DATABASE_URL = "postgres://ecom:ecom@localhost:5432/ecom";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.CORS_ORIGINS = "http://localhost:5173";
process.env.LOG_LEVEL = "fatal";

let upstream;
let upstreamUrl;
let received;
let createProxy;
let signAccessToken;
let signInternalToken;
let verifyToken;
let TOKEN_AUDIENCE;
let errorHandler;
let createLogger;

before(async () => {
  // The upstream must exist before config validation reads its URL.
  upstreamUrl = await startUpstream();

  for (const key of [
    "ACCOUNT_SERVICE_URL",
    "CART_SERVICE_URL",
    "INVENTORY_SERVICE_URL",
    "ORDER_STATUS_SERVICE_URL",
    "PAYMENT_SERVICE_URL",
    "PLACE_ORDER_SERVICE_URL",
    "PRODUCT_REVIEW_SERVICE_URL",
    "RECOMMENDATION_SERVICE_URL",
    "RECOMMENDATION_GENERATION_SERVICE_URL",
    "SEARCH_SERVICE_URL",
    "SHIPPING_SERVICE_URL",
  ]) {
    process.env[key] = upstreamUrl;
  }

  ({ createProxy } = await import("../src/lib/proxy.js"));
  ({ signAccessToken, signInternalToken, verifyToken, TOKEN_AUDIENCE, errorHandler, createLogger } =
    await import("@ecom/shared"));
});

after(async () => {
  await new Promise((resolve) => upstream.close(resolve));
});

function startUpstream() {
  const app = express();
  app.use(express.json());

  app.all("/echo/*", (req, res) => {
    received = {
      method: req.method,
      path: req.path,
      query: req.query,
      headers: req.headers,
      body: req.body,
    };
    res.json({ ok: true, saw: received });
  });

  app.get("/boom/conflict", (req, res) => {
    res.status(409).json({
      error: {
        message: "Only 3 of Arc LED Desk Lamp left in stock.",
        errorType: "Conflict",
        errorCode: "INV_INSUFFICIENT_STOCK",
        statusCode: 409,
        details: { available: 3 },
      },
    });
  });

  app.get("/boom/server", (req, res) => {
    res.status(500).json({
      error: { message: "connection string postgres://u:hunter2@db failed", statusCode: 500 },
    });
  });

  app.get("/empty", (req, res) => res.status(204).end());
  app.post("/created", (req, res) => res.status(201).json({ id: "new-thing" }));
  app.post("/accepted", (req, res) => res.status(202).json({ queued: true }));

  return new Promise((resolve) => {
    upstream = createServer(app).listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${upstream.address().port}`);
    });
  });
}

/** Mounts a proxy on a throwaway app and returns its base URL. */
async function mountProxy(mountPath, { auth } = {}) {
  const app = express();
  app.use(express.json());

  if (auth) {
    app.use((req, res, next) => {
      req.auth = auth;
      next();
    });
  }

  app.use(mountPath, createProxy({ name: "stub", baseURL: upstreamUrl }));
  app.use(errorHandler(createLogger({ service: "test", level: "fatal" })));

  const server = await new Promise((resolve) => {
    const s = createServer(app).listen(0, "127.0.0.1", () => resolve(s));
  });

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe("proxy: credential handling", () => {
  it("does not forward the client's Authorization header", async () => {
    const clientToken = signAccessToken(
      { userId: "user-1", role: "customer" },
      { secret: process.env.JWT_SECRET },
    );
    const proxy = await mountProxy("/api", { auth: { userId: "user-1", role: "customer" } });

    try {
      await fetch(`${proxy.url}/api/echo/test`, {
        headers: { authorization: `Bearer ${clientToken}` },
      });
    } finally {
      await proxy.close();
    }

    // The upstream must see an internal token, never the client's.
    const forwarded = received.headers.authorization;
    assert.ok(forwarded, "an internal token should have been attached");
    assert.ok(
      !forwarded.includes(clientToken),
      "the client's own JWT must never reach the upstream",
    );
  });

  it("attaches a verifiable internal token carrying the caller's identity", async () => {
    const proxy = await mountProxy("/api", { auth: { userId: "user-42", role: "admin" } });
    try {
      await fetch(`${proxy.url}/api/echo/test`);
    } finally {
      await proxy.close();
    }

    const token = received.headers.authorization.replace(/^Bearer /i, "");
    const claims = verifyToken(token, {
      secret: process.env.INTERNAL_JWT_SECRET,
      audience: TOKEN_AUDIENCE.INTERNAL,
    });

    assert.equal(claims.sub, "user-42");
    assert.equal(claims.role, "admin");
    assert.ok(claims.exp - claims.iat <= 60, "internal tokens must be short-lived");
  });

  it("issues an anonymous internal token when no user is authenticated", async () => {
    const proxy = await mountProxy("/api");
    try {
      await fetch(`${proxy.url}/api/echo/test`);
    } finally {
      await proxy.close();
    }

    const token = received.headers.authorization.replace(/^Bearer /i, "");
    const claims = verifyToken(token, {
      secret: process.env.INTERNAL_JWT_SECRET,
      audience: TOKEN_AUDIENCE.INTERNAL,
    });

    assert.equal(claims.sub, "anonymous");
  });

  it("does not forward cookies", async () => {
    const proxy = await mountProxy("/api");
    try {
      await fetch(`${proxy.url}/api/echo/test`, {
        headers: { cookie: "ecom_rt=super-secret-refresh-token" },
      });
    } finally {
      await proxy.close();
    }

    assert.equal(received.headers.cookie, undefined);
  });

  it("does not forward the inbound Host header", async () => {
    const proxy = await mountProxy("/api");
    try {
      await fetch(`${proxy.url}/api/echo/test`);
    } finally {
      await proxy.close();
    }

    // Host must describe the upstream, not the gateway the client contacted.
    assert.ok(received.headers.host.startsWith("127.0.0.1"));
    assert.ok(!received.headers.host.includes("gateway"));
  });
});

describe("proxy: path and query", () => {
  it("strips the mount prefix", async () => {
    const proxy = await mountProxy("/api");
    try {
      await fetch(`${proxy.url}/api/echo/nested/path`);
    } finally {
      await proxy.close();
    }

    assert.equal(received.path, "/echo/nested/path");
  });

  it("forwards the query string exactly once", async () => {
    // Passing `req.url` (which still carries "?q=x") together with `params`
    // produced "?q=x&q=x", silently turning a string parameter into an array.
    const proxy = await mountProxy("/api");
    try {
      await fetch(`${proxy.url}/api/echo/test?q=shoes&page=2`);
    } finally {
      await proxy.close();
    }

    assert.equal(received.query.q, "shoes", "q should be a string, not an array");
    assert.equal(received.query.page, "2");
  });

  it("preserves repeated query parameters as an array", async () => {
    const proxy = await mountProxy("/api");
    try {
      await fetch(`${proxy.url}/api/echo/test?category=Apparel&category=Home`);
    } finally {
      await proxy.close();
    }

    assert.deepEqual(received.query.category, ["Apparel", "Home"]);
  });
});

describe("proxy: bodies", () => {
  it("forwards a POST body", async () => {
    const proxy = await mountProxy("/api");
    try {
      await fetch(`${proxy.url}/api/echo/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ productId: "abc", quantity: 3 }),
      });
    } finally {
      await proxy.close();
    }

    assert.deepEqual(received.body, { productId: "abc", quantity: 3 });
  });

  it("forwards a DELETE body", async () => {
    // DELETE /account/me carries the password as confirmation.
    const proxy = await mountProxy("/api");
    try {
      await fetch(`${proxy.url}/api/echo/test`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "confirm-me" }),
      });
    } finally {
      await proxy.close();
    }

    assert.deepEqual(received.body, { password: "confirm-me" });
  });

  it("relays the Idempotency-Key header", async () => {
    const proxy = await mountProxy("/api");
    try {
      await fetch(`${proxy.url}/api/echo/test`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "key-12345678" },
        body: JSON.stringify({ x: 1 }),
      });
    } finally {
      await proxy.close();
    }

    assert.equal(received.headers["idempotency-key"], "key-12345678");
  });
});

describe("proxy: error translation", () => {
  it("preserves an upstream 4xx message, code and details", async () => {
    // The old proxy collapsed everything into "An error occurred" / API_001.
    const proxy = await mountProxy("/api");
    let payload;
    let status;

    try {
      const response = await fetch(`${proxy.url}/api/boom/conflict`);
      status = response.status;
      payload = await response.json();
    } finally {
      await proxy.close();
    }

    assert.equal(status, 409);
    assert.equal(payload.error.message, "Only 3 of Arc LED Desk Lamp left in stock.");
    assert.equal(payload.error.errorCode, "INV_INSUFFICIENT_STOCK");
    assert.deepEqual(payload.error.details, { available: 3 });
  });

  it("suppresses upstream 5xx detail so internals cannot leak", async () => {
    const proxy = await mountProxy("/api");
    let payload;
    let status;

    try {
      const response = await fetch(`${proxy.url}/api/boom/server`);
      status = response.status;
      payload = await response.json();
    } finally {
      await proxy.close();
    }

    assert.equal(status, 500);
    assert.equal(payload.error.message, "Internal Server Error");
    assert.ok(!JSON.stringify(payload).includes("hunter2"));
  });

  it("returns 503 when the upstream is unreachable", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", createProxy({ name: "dead", baseURL: "http://127.0.0.1:1", timeout: 500 }));
    app.use(errorHandler(createLogger({ service: "test", level: "fatal" })));

    const server = await new Promise((resolve) => {
      const s = createServer(app).listen(0, "127.0.0.1", () => resolve(s));
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/anything`);
      const payload = await response.json();

      assert.equal(response.status, 503);
      assert.equal(payload.error.errorCode, "UPSTREAM_ERROR");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("relays 201 Created instead of flattening it to 200", async () => {
    // Found by running the stack: the proxy returned `res.json(data)`, which
    // defaults to 200, so every created resource looked like a plain fetch.
    const proxy = await mountProxy("/api");
    try {
      const response = await fetch(`${proxy.url}/api/created`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "thing" }),
      });

      assert.equal(response.status, 201);
      assert.deepEqual(await response.json(), { id: "new-thing" });
    } finally {
      await proxy.close();
    }
  });

  it("relays 202 Accepted", async () => {
    const proxy = await mountProxy("/api");
    try {
      const response = await fetch(`${proxy.url}/api/accepted`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });

      assert.equal(response.status, 202);
    } finally {
      await proxy.close();
    }
  });

  it("passes a 204 through without inventing a body", async () => {
    const proxy = await mountProxy("/api");
    try {
      const response = await fetch(`${proxy.url}/api/empty`);
      assert.equal(response.status, 204);
      assert.equal(await response.text(), "");
    } finally {
      await proxy.close();
    }
  });
});

describe("internal token boundary", () => {
  it("an internal token is not accepted where a client token is required", () => {
    const internal = signInternalToken(
      { userId: "u" },
      { secret: process.env.INTERNAL_JWT_SECRET },
    );

    assert.throws(
      () =>
        verifyToken(internal, { secret: process.env.JWT_SECRET, audience: TOKEN_AUDIENCE.CLIENT }),
      /Invalid token/,
    );
  });
});
