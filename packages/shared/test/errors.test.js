import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AppError, conflict, notFound } from "../src/errors.js";
import { asyncHandler, errorHandler } from "../src/http.js";
import { validate } from "../src/validate.js";
import { Joi } from "../src/config.js";
import { normaliseIp } from "../src/rateLimit.js";

const silentLogger = { error() {}, warn() {}, info() {}, debug() {} };

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    headersSent: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    end() {
      return this;
    },
  };
}

describe("AppError", () => {
  it("accepts the options form", () => {
    const err = new AppError({ message: "nope", statusCode: 404, errorCode: "X" });
    assert.equal(err.message, "nope");
    assert.equal(err.statusCode, 404);
    assert.equal(err.errorCode, "X");
  });

  it("also accepts the positional form the old code used by mistake", () => {
    // `new ErrorResponse("Product not found", 404)` used to yield an error with
    // message and statusCode both undefined. It must not any more.
    const err = new AppError("Product not found", 404);
    assert.equal(err.message, "Product not found");
    assert.equal(err.statusCode, 404);
  });

  it("defaults to a 500 with a safe message", () => {
    const err = new AppError({});
    assert.equal(err.statusCode, 500);
    assert.equal(err.expose, false);
  });

  it("marks 4xx as safe to show the client and 5xx as not", () => {
    assert.equal(notFound("gone").expose, true);
    assert.equal(new AppError({ statusCode: 500 }).expose, false);
  });
});

describe("errorHandler", () => {
  it("returns the JSON envelope for an AppError", () => {
    const res = fakeRes();
    errorHandler(silentLogger)(
      conflict("Already exists", { errorCode: "DUP" }),
      { method: "POST", originalUrl: "/x", id: "req-1" },
      res,
      () => {},
    );

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error.message, "Already exists");
    assert.equal(res.body.error.errorCode, "DUP");
    assert.equal(res.body.error.requestId, "req-1");
  });

  it("hides the message of an unexpected 500", () => {
    const res = fakeRes();
    errorHandler(silentLogger)(
      new Error("connection string postgres://user:hunter2@db/x failed"),
      { method: "GET", originalUrl: "/x" },
      res,
      () => {},
    );

    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error.message, "Internal Server Error");
    assert.ok(!JSON.stringify(res.body).includes("hunter2"));
  });

  it("maps a Postgres unique violation to 409", () => {
    const res = fakeRes();
    const pgError = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "users_email_key",
    });

    errorHandler(silentLogger)(pgError, { method: "POST", originalUrl: "/x" }, res, () => {});

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error.errorCode, "DB_UNIQUE_VIOLATION");
  });

  it("maps malformed JSON to 400", () => {
    const res = fakeRes();
    errorHandler(silentLogger)(
      Object.assign(new Error("bad json"), { type: "entity.parse.failed" }),
      { method: "POST", originalUrl: "/x" },
      res,
      () => {},
    );

    assert.equal(res.statusCode, 400);
  });
});

describe("asyncHandler", () => {
  it("forwards a rejection to next", async () => {
    let captured;
    const handler = asyncHandler(async () => {
      throw notFound("missing");
    });

    await handler({}, {}, (err) => {
      captured = err;
    });

    assert.equal(captured.statusCode, 404);
  });

  it("rejects loudly when invoked outside a request", async () => {
    // The old asyncHandler swallowed this into an unhandled rejection that
    // killed the process at boot.
    const handler = asyncHandler(async () => "never runs");

    await assert.rejects(() => handler({}, {}), /called outside an Express request/);
  });
});

describe("validate", () => {
  const schema = Joi.object({
    name: Joi.string().min(2).required(),
    age: Joi.number().integer().min(0),
  });

  it("rejects an empty body with a specific code", () => {
    let error;
    validate(schema)({ body: {} }, {}, (err) => {
      error = err;
    });

    assert.equal(error.statusCode, 400);
    assert.equal(error.errorCode, "VAL_EMPTY_BODY");
  });

  it("reports every failing field, not only the first", () => {
    let error;
    validate(schema)({ body: { name: "x", age: -5 } }, {}, (err) => {
      error = err;
    });

    assert.equal(error.details.length, 2);
    assert.deepEqual(error.details.map((d) => d.field).sort(), ["age", "name"]);
  });

  it("strips unknown keys so handlers only see whitelisted fields", () => {
    const req = { body: { name: "Ada", isAdmin: true } };
    validate(schema)(req, {}, () => {});

    assert.deepEqual(req.body, { name: "Ada" });
  });

  it("coerces types", () => {
    const req = { body: { name: "Ada", age: "42" } };
    validate(schema)(req, {}, () => {});

    assert.equal(req.body.age, 42);
  });
});

describe("normaliseIp", () => {
  it("passes IPv4 through unchanged", () => {
    assert.equal(normaliseIp("203.0.113.5"), "203.0.113.5");
  });

  it("unwraps IPv4-mapped IPv6", () => {
    assert.equal(normaliseIp("::ffff:203.0.113.5"), "203.0.113.5");
  });

  it("collapses IPv6 to a /64 so a subnet cannot multiply its quota", () => {
    const a = normaliseIp("2001:db8:1234:5678:aaaa:bbbb:cccc:dddd");
    const b = normaliseIp("2001:db8:1234:5678:1111:2222:3333:4444");

    assert.equal(a, b);
    assert.equal(a, "2001:db8:1234:5678::/64");
  });

  it("expands a compressed IPv6 address before truncating", () => {
    assert.equal(normaliseIp("2001:db8::1"), "2001:db8:0:0::/64");
  });

  it("handles a missing address", () => {
    assert.equal(normaliseIp(undefined), "unknown");
  });
});

describe("validate: empty bodies", () => {
  // Found by running the stack: a blanket "body must not be empty" rejection
  // 400'd endpoints whose fields are all optional — a view ping, an order
  // cancellation with no reason — before the schema ever ran.
  it("accepts an empty body when the schema has no required fields", () => {
    const optional = Joi.object({ sessionId: Joi.string().allow("", null).default(null) });
    const req = { body: {} };
    let error = "unset";

    validate(optional)(req, {}, (err) => {
      error = err;
    });

    assert.equal(error, undefined);
    assert.deepEqual(req.body, { sessionId: null });
  });

  it("accepts a missing body when the schema has no required fields", () => {
    const optional = Joi.object({ reason: Joi.string().allow("", null).default(null) });
    const req = { body: undefined };
    let error = "unset";

    validate(optional)(req, {}, (err) => {
      error = err;
    });

    assert.equal(error, undefined);
  });

  it("still rejects an empty body when the schema requires a field", () => {
    const required = Joi.object({ email: Joi.string().required() });
    let error;

    validate(required)({ body: {} }, {}, (err) => {
      error = err;
    });

    assert.equal(error.statusCode, 400);
    assert.equal(error.errorCode, "VAL_EMPTY_BODY");
  });

  it("still rejects an empty body for a patch schema requiring at least one key", () => {
    const patch = Joi.object({ city: Joi.string(), zip: Joi.string() }).min(1);
    let error;

    validate(patch)({ body: {} }, {}, (err) => {
      error = err;
    });

    assert.equal(error.statusCode, 400);
  });
});
