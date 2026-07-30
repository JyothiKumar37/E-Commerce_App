/**
 * Gateway routing-policy tests.
 *
 * These assert the authorisation *table* rather than hitting the network: the
 * original code's worst bug class was a route being public that should not have
 * been (catalog writes, inventory adjustments), and that is decided entirely by
 * this table.
 *
 * Run with: npm test --workspace @ecom/api-gateway
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

let ROUTE_TABLE;
let isPublicPost;

before(async () => {
  ({ ROUTE_TABLE, isPublicPost } = await import("../src/routes.js"));
});

describe("route table", () => {
  it("routes every service the gateway advertises", () => {
    const paths = ROUTE_TABLE.map((r) => r.path).sort();
    assert.deepEqual(paths, [
      "/account",
      "/cart",
      "/catalog",
      "/checkout",
      "/inventory",
      "/orders",
      "/payments",
      "/recommendation-jobs",
      "/recommendations",
      "/reviews",
      "/shipping",
    ]);
  });

  it("requires authentication for everything touching a user's own data", () => {
    const mustBeProtected = ["/account", "/cart", "/orders", "/payments", "/checkout", "/shipping"];

    for (const path of mustBeProtected) {
      const route = ROUTE_TABLE.find((r) => r.path === path);
      assert.equal(route.auth, "required", `${path} must require authentication`);
    }
  });

  it("restricts catalog writes to admins while leaving reads public", () => {
    // Previously POST/PUT/DELETE on the catalog were reachable by anyone.
    const catalog = ROUTE_TABLE.find((r) => r.path === "/catalog");

    assert.equal(catalog.auth, "optional", "browsing the catalog must not need an account");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.equal(catalog.methodAuth[method], "admin", `${method} /catalog must be admin-only`);
    }
  });

  it("restricts inventory mutations to admins", () => {
    const inventory = ROUTE_TABLE.find((r) => r.path === "/inventory");

    assert.equal(inventory.auth, "optional");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.equal(inventory.methodAuth[method], "admin");
    }
  });

  it("lets anyone read reviews but only signed-in users write them", () => {
    const reviews = ROUTE_TABLE.find((r) => r.path === "/reviews");

    assert.equal(reviews.auth, "optional");
    assert.equal(reviews.methodAuth.POST, "required");
    assert.equal(reviews.methodAuth.DELETE, "required");
  });

  it("keeps the recommendation batch job admin-only", () => {
    const jobs = ROUTE_TABLE.find((r) => r.path === "/recommendation-jobs");
    assert.equal(jobs.auth, "admin");
  });

  it("gives every route a resolvable upstream", () => {
    for (const route of ROUTE_TABLE) {
      assert.ok(route.target, `${route.path} has no target`);
      assert.doesNotThrow(() => new URL(route.target), `${route.path} target is not a URL`);
    }
  });

  it("exempts exactly the intended POSTs from the admin-write rule", () => {
    // View tracking carries a product id in the path, so an exact-string
    // lookup would never match it and every anonymous view would 403.
    assert.equal(isPublicPost("/search"), true);
    assert.equal(isPublicPost("/products/8f14e45f-ceea-467a-9a3f-4b2c1d0e5a6b/views"), true);

    // Nothing else may slip through.
    assert.equal(isPublicPost("/products"), false);
    assert.equal(isPublicPost("/products/lookup"), false);
    assert.equal(isPublicPost("/admin/reindex"), false);
    assert.equal(isPublicPost("/products/abc/views/../../products"), false);
    assert.equal(isPublicPost("/search/products"), false);
  });

  it("uses only known auth policies", () => {
    const allowed = new Set(["required", "optional", "admin"]);

    for (const route of ROUTE_TABLE) {
      assert.ok(allowed.has(route.auth), `${route.path}: unknown policy "${route.auth}"`);
      for (const policy of Object.values(route.methodAuth ?? {})) {
        assert.ok(allowed.has(policy), `${route.path}: unknown method policy "${policy}"`);
      }
    }
  });
});
