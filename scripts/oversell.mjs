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

  await call("POST", "/cart/items", {
    token,
    cookie,
    body: { productId: product.productId, quantity: 1 },
  });

  const preview = await call(
    "GET",
    `/checkout/preview?shippingAddressId=${addr.data.address.addressId}`,
    {
      token,
      cookie,
    },
  );

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

console.log(`\n  ${failed === 0 ? "No overselling." : `${failed} problem(s).`}\n`);
process.exit(failed === 0 ? 0 : 1);
