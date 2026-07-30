/**
 * Production configuration guards.
 *
 * These exist because the safe default for local development is the dangerous
 * default for production: CORS pointing at localhost, Postgres with TLS off.
 * A service that boots happily with either of those in production is a silent
 * incident, so misconfiguration has to be a startup failure instead.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Joi, loadConfig, baseEnvSchema, postgresEnvSchema } from "../src/index.js";

const schema = Joi.object({ ...baseEnvSchema, ...postgresEnvSchema });

const base = {
  INTERNAL_JWT_SECRET: "x".repeat(48),
  DATABASE_URL: "postgres://user:pass@db:5432/ecom",
};

const prod = (overrides = {}) => ({
  ...base,
  NODE_ENV: "production",
  CORS_ORIGINS: "https://shop.example.com",
  PGSSLMODE: "require",
  ...overrides,
});

describe("CORS in production", () => {
  it("refuses to start on the localhost default", () => {
    assert.throws(
      () => loadConfig(schema, { ...base, NODE_ENV: "production", PGSSLMODE: "require" }),
      /CORS_ORIGINS/,
    );
  });

  it("refuses a wildcard origin", () => {
    // The API sends credentials, so `*` would expose it to every site.
    assert.throws(() => loadConfig(schema, prod({ CORS_ORIGINS: "*" })), /wildcard|\*/);
  });

  it("refuses a leftover local origin among real ones", () => {
    assert.throws(
      () =>
        loadConfig(
          schema,
          prod({ CORS_ORIGINS: "https://shop.example.com,http://localhost:5173" }),
        ),
      /local origin/,
    );
  });

  it("refuses a bare loopback address", () => {
    assert.throws(
      () => loadConfig(schema, prod({ CORS_ORIGINS: "http://127.0.0.1:8080" })),
      /local origin/,
    );
  });

  it("accepts real origins", () => {
    const config = loadConfig(
      schema,
      prod({ CORS_ORIGINS: "https://shop.example.com,https://www.example.com" }),
    );
    assert.equal(config.CORS_ORIGINS, "https://shop.example.com,https://www.example.com");
  });

  it("still defaults to localhost outside production", () => {
    assert.equal(loadConfig(schema, base).CORS_ORIGINS, "http://localhost:5173");
  });
});

describe("Postgres TLS in production", () => {
  it("refuses PGSSLMODE=disable", () => {
    assert.throws(() => loadConfig(schema, prod({ PGSSLMODE: "disable" })), /PGSSLMODE/);
  });

  it("defaults to require when unset", () => {
    const config = loadConfig(schema, {
      ...base,
      NODE_ENV: "production",
      CORS_ORIGINS: "https://shop.example.com",
    });
    assert.equal(config.PGSSLMODE, "require");
  });

  it("allows no-verify as a deliberate escape hatch", () => {
    assert.equal(loadConfig(schema, prod({ PGSSLMODE: "no-verify" })).PGSSLMODE, "no-verify");
  });

  it("still defaults to disable outside production", () => {
    assert.equal(loadConfig(schema, base).PGSSLMODE, "disable");
  });
});

describe("secrets", () => {
  it("rejects an internal secret shorter than 32 characters", () => {
    assert.throws(
      () => loadConfig(schema, { ...base, INTERNAL_JWT_SECRET: "tooshort" }),
      /at least 32/,
    );
  });

  it("requires the internal secret at all", () => {
    assert.throws(
      () => loadConfig(schema, { DATABASE_URL: base.DATABASE_URL }),
      /INTERNAL_JWT_SECRET is required/,
    );
  });
});

describe("loadConfig", () => {
  it("reports every problem at once, not just the first", () => {
    let message = "";
    try {
      loadConfig(schema, { NODE_ENV: "production" });
    } catch (err) {
      message = err.message;
    }

    // Missing secret, missing database URL and a bad CORS value should all be
    // listed, so one restart surfaces the whole misconfiguration.
    assert.match(message, /INTERNAL_JWT_SECRET/);
    assert.match(message, /DATABASE_URL/);
    assert.ok(message.split("\n").length >= 3, `expected several problems, got:\n${message}`);
  });

  it("coerces types rather than handing back strings", () => {
    const config = loadConfig(schema, { ...base, PG_POOL_MAX: "25" });
    assert.strictEqual(config.PG_POOL_MAX, 25);
  });

  it("freezes the result so config cannot drift at runtime", () => {
    const config = loadConfig(schema, base);
    assert.throws(() => {
      config.PG_POOL_MAX = 999;
    }, TypeError);
  });
});
