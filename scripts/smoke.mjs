#!/usr/bin/env node
/**
 * Constructs every service's Express app with placeholder configuration.
 *
 * Catches config-schema errors, bad route patterns, undefined middleware and
 * unresolved imports without needing Postgres, Redis or Elasticsearch — the
 * class of failure that otherwise only shows up on first boot in CI.
 *
 *   node scripts/smoke.mjs
 */
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "fatal";
process.env.INTERNAL_JWT_SECRET = "smoke-internal-secret-at-least-32-characters";
process.env.JWT_SECRET = "smoke-client-secret-at-least-32-characters!!";
process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/ecom";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.ELASTICSEARCH_URL = "http://localhost:9200";
process.env.CORS_ORIGINS = "http://localhost:5173";

const PORTS = {
  "api-gateway": 8080,
  account: 8081,
  cart: 8082,
  inventory: 8083,
  "order-status": 8084,
  payment: 8085,
  "place-order": 8086,
  "product-review": 8087,
  recommendation: 8088,
  "recommendation-generation": 8089,
  search: 8090,
  shipping: 8091,
};

// The gateway's config demands a URL for every downstream service.
const ENV_KEYS = {
  account: "ACCOUNT_SERVICE_URL",
  cart: "CART_SERVICE_URL",
  inventory: "INVENTORY_SERVICE_URL",
  "order-status": "ORDER_STATUS_SERVICE_URL",
  payment: "PAYMENT_SERVICE_URL",
  "place-order": "PLACE_ORDER_SERVICE_URL",
  "product-review": "PRODUCT_REVIEW_SERVICE_URL",
  recommendation: "RECOMMENDATION_SERVICE_URL",
  "recommendation-generation": "RECOMMENDATION_GENERATION_SERVICE_URL",
  search: "SEARCH_SERVICE_URL",
  shipping: "SHIPPING_SERVICE_URL",
};
for (const [name, key] of Object.entries(ENV_KEYS)) {
  process.env[key] = `http://localhost:${PORTS[name]}`;
}

const targets = [
  ["api-gateway", join(ROOT, "apps/api-gateway/src/app.js")],
  ...(await readdir(join(ROOT, "services"), { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => [e.name, join(ROOT, "services", e.name, "src/app.js")])
    .sort((a, b) => a[0].localeCompare(b[0])),
];

// Each service registers its own SIGTERM/SIGINT handlers on import.
process.setMaxListeners(targets.length + 10);

let failures = 0;

for (const [name, path] of targets) {
  process.env.SERVICE_NAME = name;
  process.env.PORT = String(PORTS[name] ?? 8080);

  try {
    const mod = await import(path);
    if (typeof mod.buildApp !== "function") {
      throw new Error("does not export buildApp()");
    }
    mod.buildApp();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}: ${err.message}`);
    if (process.env.VERBOSE) console.error(err.stack);
  }
}

console.log(
  failures === 0
    ? `\nAll ${targets.length} services constructed cleanly.\n`
    : `\n${failures} of ${targets.length} services failed to construct.\n`,
);
process.exit(failures === 0 ? 0 : 1);
