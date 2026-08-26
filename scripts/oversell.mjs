/**
 * Oversell test.
 *
 * Requires a running, seeded stack:
 *
 *   npm run up && npm run db:setup
 *   npm run test:oversell
 *
 * NOTE: this mutates real stock and creates real orders. Run it against a
 * development database only.
 *
 * Sets a product to exactly N units, then fires N+K concurrent checkouts each
 * wanting one. Exactly N must succeed, stock must land on zero, and it must
 * never go negative. This is the claim the row-level locking exists to make.
 */
import { randomUUID } from "node:crypto";

const API = process.env.API_URL ?? "http://127.0.0.1:8080";

// An empty host is almost always an unset shell variable, and the symptom does
// not say so. WHATWG URL parsing collapses the empty authority in "http:///api"
// and promotes the first path segment to the hostname, so Node resolves DNS for
// a host literally called "api" and fails with EAI_AGAIN — a stack trace that
// names undici and never mentions the variable that was not set.
if (/^[a-z][a-z0-9+.-]*:\/\/\//i.test(API)) {
  console.error(`\nAPI_URL has no host: ${API}`);
  console.error("An unset shell variable is the usual cause —");
  console.error("  API_URL=http://$LB/api   with LB empty   becomes   http:///api\n");
  console.error("Set it first, for example:");
  console.error("  export LB=$(kubectl -n ingress-nginx get svc ingress-nginx-controller \\");
  console.error("    -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')\n");
  process.exit(2);
}

const STOCK = 5;
const SHOPPERS = 12;

async function call(method, path, { body, token, cookie, key } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = cookie;
  if (key) headers["idempotency-key"] = key;

  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null, res };
}

// --- pick a product and pin its stock -------------------------------------
const admin = await call("POST", "/auth/signin", {
  body: { email: "admin@example.com", password: "Admin123!Pass" },
});
const adminToken = admin.data.accessToken;

const search = await call("POST", "/catalog/search", { body: { q: "", pageSize: 50 } });
const product = search.data.items.find((p) => p.name.includes("Stoneware")) ?? search.data.items[0];

const current = await call("GET", `/inventory/stock/${product.productId}`);
const delta = STOCK - current.data.stock.available;
if (delta !== 0) {
  const adj = await call("POST", `/inventory/stock/${product.productId}/adjust`, {
    token: adminToken,
    body: { delta, reason: "race test setup" },
  });
  if (adj.status !== 200) {
    console.error("could not pin stock:", adj.status, JSON.stringify(adj.data));
    process.exit(1);
  }
}

const pinned = await call("GET", `/inventory/stock/${product.productId}`);
console.log(`\nProduct: ${product.name}`);
console.log(`Stock pinned to: ${pinned.data.stock.available}`);
console.log(`Concurrent shoppers: ${SHOPPERS}, each buying 1\n`);

// --- create independent shoppers ------------------------------------------
async function makeShopper(i) {
  const stamp = `${Date.now()}${i}`;
  const signup = await call("POST", "/auth/signup", {
    body: {
      username: `race${stamp}`.slice(0, 30),
      email: `race-${stamp}@example.com`,
      password: "Password123!",
      first_name: "Race",
      last_name: "Tester",
    },
  });
  const token = signup.data.accessToken;
  const cookie = signup.res.headers.get("set-cookie")?.split(";")[0];

  const addr = await call("POST", "/account/me/addresses", {
    token,
    cookie,
    body: {
      recipient_name: "Race Tester",
      address_line1: "1 Contention Way",
      city: "Berlin",
      country: "Germany",
      zip: "10115",
    },
  });

  // Add to the cart, retrying transient setup failures. Without this, a dropped
  // add during the concurrent setup leaves an empty cart that only surfaces as a
  // spurious CART_EMPTY at checkout and gets miscounted as an oversell failure,
  // rather than the setup hiccup it is. A 409 (insufficient stock) is a real
  // business answer, not transient, so we stop on it.
  let added;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    added = await call("POST", "/cart/items", {
      token,
      cookie,
      body: { productId: product.productId, quantity: 1 },
    });
    if (added.status === 201 || added.data?.error?.errorCode === "INSUFFICIENT_STOCK") break;
    await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
  }
  if (added.status !== 201) {
    throw new Error(
      `shopper ${i} setup: add-to-cart failed (${added.status} ${added.data?.error?.errorCode ?? ""})`,
    );
  }

  const preview = await call(
    "GET",
    `/checkout/preview?shippingAddressId=${addr.data.address.addressId}`,
    { token, cookie },
  );
  if (preview.status !== 200 || preview.data?.totals?.totalCents == null) {
    throw new Error(
      `shopper ${i} setup: checkout preview failed (${preview.status} ${preview.data?.error?.errorCode ?? ""})`,
    );
  }

  return {
    token,
    cookie,
    addressId: addr.data.address.addressId,
    total: preview.data.totals.totalCents,
  };
}

const shoppers = await Promise.all(Array.from({ length: SHOPPERS }, (_, i) => makeShopper(i)));

// --- everyone checks out at once ------------------------------------------
const started = Date.now();
const results = await Promise.all(
  shoppers.map((s) =>
    call("POST", "/checkout/orders", {
      token: s.token,
      cookie: s.cookie,
      key: randomUUID(),
      body: {
        shippingAddressId: s.addressId,
        paymentMethod: "card",
        paymentToken: "tok_test_success",
        expectedTotalCents: s.total,
      },
    }).then(
      (result) => result,
      (err) => ({ status: 0, data: { error: { message: err.message } } }),
    ),
  ),
);
const elapsed = Date.now() - started;

const succeeded = results.filter((r) => r.status === 201);
const outOfStock = results.filter((r) => r.data?.error?.errorCode === "INV_INSUFFICIENT_STOCK");
const other = results.filter(
  (r) => r.status !== 201 && r.data?.error?.errorCode !== "INV_INSUFFICIENT_STOCK",
);

const final = await call("GET", `/inventory/stock/${product.productId}`);

console.log(`Completed in ${elapsed}ms\n`);
console.log(`  orders placed          ${succeeded.length}`);
console.log(`  rejected: out of stock ${outOfStock.length}`);
console.log(`  rejected: other        ${other.length}`);
console.log(`  stock remaining        ${final.data.stock.available}`);
console.log(`  stock reserved         ${final.data.stock.reserved}\n`);

for (const r of other) {
  console.log(
    `  other rejection: ${r.status} ${r.data?.error?.errorCode} ${r.data?.error?.message}`,
  );
}

let failed = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok    ${label}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${label}\n          ${detail}`);
  }
};

console.log("");
check(
  "exactly the available units were sold",
  succeeded.length === STOCK,
  `${succeeded.length} sold, stock was ${STOCK}`,
);
check(
  "everyone else was told it was out of stock",
  outOfStock.length === SHOPPERS - STOCK,
  `${outOfStock.length} of an expected ${SHOPPERS - STOCK}`,
);
check(
  "no unexpected errors (no deadlocks, no 500s)",
  other.length === 0,
  `${other.length} other failures`,
);
check(
  "stock is exactly zero, never negative",
  final.data.stock.available === 0,
  `available=${final.data.stock.available}`,
);
check(
  "no stock left dangling in 'reserved'",
  final.data.stock.reserved === 0,
  `reserved=${final.data.stock.reserved}`,
);
check(
  "every successful order got a distinct id",
  new Set(succeeded.map((r) => r.data.order.orderId)).size === succeeded.length,
  "duplicate order ids",
);

// --- put the stock back ----------------------------------------------------
//
// This test deliberately sells a product down to zero, and used to leave it
// there. The e2e suite then picked that same product as its first in-stock item
// and failed eighteen assertions in a cascade from one 409 — a broken run that
// said nothing about the application.
//
// A harness that mutates seeded data has to restore it, or the suites can only
// ever be run in one order, and only once.
const restored = await call("POST", `/inventory/stock/${product.productId}/adjust`, {
  token: adminToken,
  body: {
    delta: current.data.stock.available - final.data.stock.available,
    reason: "race test teardown",
  },
});
if (restored.status === 200) {
  const back = await call("GET", `/inventory/stock/${product.productId}`);
  console.log(`  stock restored to ${back.data.stock.available}`);
} else {
  console.log(`  WARNING: could not restore stock (${restored.status}). Re-run the seed job.`);
}

console.log(`\n  ${failed === 0 ? "No overselling." : `${failed} problem(s).`}\n`);
process.exit(failed === 0 ? 0 : 1);
