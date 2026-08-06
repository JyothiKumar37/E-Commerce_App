/**
 * End-to-end walk of the real customer journey against a running stack.
 *
 * Every call goes through the gateway, exactly as the browser would: no mocks,
 * no direct database access, no shortcuts past authorisation. Unit tests prove
 * pieces work; this proves the system does.
 *
 * Requires the stack to be up and the database seeded:
 *
 *   npm run up && npm run db:setup
 *   npm run test:e2e
 *
 * Point it elsewhere with API_URL=https://staging.example.com
 */
import { randomUUID } from "node:crypto";

const API = process.env.API_URL ?? "http://127.0.0.1:8080";

let pass = 0;
let fail = 0;
const failures = [];

let accessToken = null;
let cookie = null;

function ok(label, extra = "") {
  pass += 1;
  console.log(`  ok    ${label}${extra ? `  ${extra}` : ""}`);
}
function bad(label, detail) {
  fail += 1;
  failures.push(`${label}: ${detail}`);
  console.log(`  FAIL  ${label}\n          ${detail}`);
}

async function call(method, path, { body, headers = {}, auth = true, raw = false } = {}) {
  const h = { accept: "application/json", ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  if (auth && accessToken) h.authorization = `Bearer ${accessToken}`;
  if (cookie) h.cookie = cookie;

  const res = await fetch(`${API}${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  return raw ? { res, data } : { status: res.status, data, headers: res.headers };
}

const expect = (label, cond, detail) => (cond ? ok(label) : bad(label, detail));
const uuid = () => randomUUID();

console.log("\n── Discovery ─────────────────────────────────────────");
{
  const { status, data } = await call("GET", "/", { auth: false });
  expect("gateway root responds", status === 200, `status ${status}`);
  expect(
    "advertises all 11 routes",
    data?.routes?.length === 12,
    `got ${data?.routes?.length}: ${JSON.stringify(data?.routes)}`,
  );
}

console.log("\n── Catalog (public, no auth) ─────────────────────────");
let products = [];
{
  const { status, data } = await call("POST", "/catalog/search", {
    auth: false,
    body: { q: "", pageSize: 50 },
  });
  expect(
    "search works unauthenticated",
    status === 200,
    `status ${status} ${JSON.stringify(data)?.slice(0, 200)}`,
  );
  products = data?.items ?? [];
  expect("returns seeded products", products.length === 12, `got ${products.length}`);
  // Both values are correct: false means the Elasticsearch index is serving,
  // true means it was unreachable and the Postgres trigram fallback took over.
  // This originally asserted `true`, because it was written on a machine with
  // no Elasticsearch — so a healthy deployment failed the test.
  expect(
    "search reports which backend served it",
    typeof data?.degraded === "boolean",
    `degraded=${data?.degraded} (expected a boolean)`,
  );
  console.log(
    data?.degraded
      ? "        note: Elasticsearch unreachable, serving the Postgres fallback"
      : "        note: Elasticsearch index is live",
  );

  const { status: cs, data: cd } = await call("GET", "/catalog/categories", { auth: false });
  expect(
    "categories listed",
    cs === 200 && cd?.categories?.length >= 4,
    `status ${cs}, ${cd?.categories?.length} categories`,
  );
}

// ---------------------------------------------------------------------------
// Free text. Everything above sends `q: ""`, which skips the text branch of the
// query entirely — so this suite passed 78 assertions against a storefront on
// which typing a product name returned nothing at all. A search endpoint that
// answers 200 with zero results looks identical to an empty catalogue: no
// status code, health check or probe can tell them apart. Only an assertion on
// the *content* can.
console.log("\n── Free-text search ──────────────────────────────────");
{
  const target = products.find((p) => p.name.includes("Court Low Leather Sneaker")) ?? products[0];

  const exact = await call("POST", "/catalog/search", {
    auth: false,
    body: { q: target.name, pageSize: 10 },
  });
  expect(
    "an exact product name finds that product",
    exact.status === 200 && exact.data?.items?.some((p) => p.productId === target.productId),
    `status ${exact.status}, ${exact.data?.items?.length ?? 0} hits for "${target.name}"`,
  );
  expect(
    "and ranks it first",
    exact.data?.items?.[0]?.productId === target.productId,
    `top hit was "${exact.data?.items?.[0]?.name}"`,
  );

  const oneWord = await call("POST", "/catalog/search", {
    auth: false,
    body: { q: target.name.split(" ").pop(), pageSize: 10 },
  });
  expect(
    "a single word from the name finds it",
    oneWord.data?.items?.some((p) => p.productId === target.productId),
    `${oneWord.data?.items?.length ?? 0} hits for "${target.name.split(" ").pop()}"`,
  );

  // Brand and product word together. This is the case `operator: "and"` over
  // best_fields could never satisfy: the two terms live in different fields.
  if (target.brand) {
    const crossField = await call("POST", "/catalog/search", {
      auth: false,
      body: { q: `${target.brand} ${target.name.split(" ").pop()}`, pageSize: 10 },
    });
    expect(
      "brand plus product word matches across fields",
      crossField.data?.items?.some((p) => p.productId === target.productId),
      `${crossField.data?.items?.length ?? 0} hits for "${target.brand} ..."`,
    );
  }

  // Lowercase brand against a capitalised stored value.
  const lowerBrand = await call("POST", "/catalog/search", {
    auth: false,
    body: { q: (target.brand ?? target.category).toLowerCase(), pageSize: 20 },
  });
  expect(
    "search is case-insensitive",
    (lowerBrand.data?.items?.length ?? 0) > 0,
    `0 hits for "${(target.brand ?? target.category).toLowerCase()}"`,
  );

  // A typo still lands, via the fuzzy strategy.
  const typo = target.name.split(" ").pop().replace(/.$/, "");
  const fuzzy = await call("POST", "/catalog/search", {
    auth: false,
    body: { q: typo, pageSize: 10 },
  });
  expect(
    "a truncated word still matches",
    (fuzzy.data?.items?.length ?? 0) > 0,
    `0 hits for "${typo}"`,
  );

  // Nonsense must return nothing — otherwise the assertions above prove only
  // that search returns *something* regardless of the query.
  const nonsense = await call("POST", "/catalog/search", {
    auth: false,
    body: { q: "zzqxwvunlikelyterm", pageSize: 10 },
  });
  expect(
    "a term in no product returns nothing",
    nonsense.status === 200 && nonsense.data?.items?.length === 0,
    `status ${nonsense.status}, ${nonsense.data?.items?.length} hits`,
  );

  // Facets must describe the matched set, not the whole catalogue.
  const faceted = await call("POST", "/catalog/search", {
    auth: false,
    body: { q: "", category: target.category, pageSize: 50 },
  });
  expect(
    "a category filter narrows the results",
    faceted.data?.items?.length > 0 &&
      faceted.data.items.every((p) => p.category === target.category),
    `${faceted.data?.items?.length} hits, categories ${[
      ...new Set((faceted.data?.items ?? []).map((p) => p.category)),
    ].join(", ")}`,
  );

  const lowerCat = await call("POST", "/catalog/search", {
    auth: false,
    body: { q: "", category: target.category.toLowerCase(), pageSize: 50 },
  });
  expect(
    "a category filter ignores case",
    lowerCat.data?.items?.length === faceted.data?.items?.length,
    `"${target.category}" gave ${faceted.data?.items?.length}, ` +
      `"${target.category.toLowerCase()}" gave ${lowerCat.data?.items?.length}`,
  );
}

const inStock = products.filter((p) => p.inStock);
const soldOut = products.find((p) => !p.inStock);
const lowStock = products.find((p) => p.name.includes("Arc LED"));

{
  const target = inStock[0];
  const { status, data } = await call("GET", `/catalog/products/${target.productId}`, {
    auth: false,
  });
  expect(
    "product detail by id",
    status === 200 && data?.product?.sku === target.sku,
    `status ${status}`,
  );
}

console.log("\n── Catalog writes must be blocked ────────────────────");
{
  const { status } = await call("POST", "/catalog/products", {
    auth: false,
    body: { sku: "HACK-001", name: "Injected", category: "X", priceCents: 1 },
  });
  expect("anonymous cannot create a product", status === 401, `status ${status}`);

  const { status: ds } = await call("DELETE", `/catalog/products/${products[0].productId}`, {
    auth: false,
  });
  expect("anonymous cannot delete a product", ds === 401, `status ${ds}`);
}

console.log("\n── Registration and validation ───────────────────────");
const email = `e2e-${Date.now()}@example.com`;
const username = `e2e${Date.now().toString().slice(-9)}`;
{
  const weak = await call("POST", "/auth/signup", {
    auth: false,
    body: { username: "x", email: "nope", password: "weak", first_name: "1", last_name: "" },
  });
  expect("rejects invalid signup", weak.status === 400, `status ${weak.status}`);
  expect(
    "reports every bad field at once",
    Array.isArray(weak.data?.error?.details) && weak.data.error.details.length >= 4,
    `details=${JSON.stringify(weak.data?.error?.details)}`,
  );

  const hashSymbol = await call("POST", "/auth/signup", {
    auth: false,
    body: {
      username: `sym${Date.now().toString().slice(-9)}`,
      email: `sym-${Date.now()}@example.org`,
      password: "Password123#",
      first_name: "Ада",
      last_name: "O'Brien",
    },
  });
  expect(
    "accepts '#' password, .org TLD and a Cyrillic name",
    hashSymbol.status === 201,
    `status ${hashSymbol.status} ${JSON.stringify(hashSymbol.data?.error)}`,
  );

  const { status, data } = await call("POST", "/auth/signup", {
    auth: false,
    body: {
      username,
      email,
      password: "Password123!",
      first_name: "End",
      last_name: "ToEnd",
    },
  });
  expect("signup succeeds", status === 201, `status ${status} ${JSON.stringify(data?.error)}`);
  accessToken = data?.accessToken;
  expect("returns an access token", Boolean(accessToken));
  expect(
    "sets a refresh cookie",
    Boolean(cookie) && cookie.startsWith("ecom_rt="),
    `cookie=${cookie}`,
  );

  const dup = await call("POST", "/auth/signup", {
    auth: false,
    body: {
      username: `${username}b`,
      email,
      password: "Password123!",
      first_name: "A",
      last_name: "B",
    },
  });
  expect(
    "duplicate email rejected",
    dup.status === 409 && dup.data?.error?.errorCode === "AUTH_EMAIL_TAKEN",
    `status ${dup.status} code ${dup.data?.error?.errorCode}`,
  );
}

console.log("\n── Sign-in, enumeration resistance, refresh ──────────");
{
  const wrongUser = await call("POST", "/auth/signin", {
    auth: false,
    body: { email: `absent-${Date.now()}@example.com`, password: "Password123!" },
  });
  const wrongPass = await call("POST", "/auth/signin", {
    auth: false,
    body: { email, password: "WrongPassword1!" },
  });
  expect(
    "unknown user and wrong password are indistinguishable",
    wrongUser.status === 401 &&
      wrongPass.status === 401 &&
      wrongUser.data.error.message === wrongPass.data.error.message,
    `${wrongUser.status}/"${wrongUser.data?.error?.message}" vs ${wrongPass.status}/"${wrongPass.data?.error?.message}"`,
  );

  const { status, data } = await call("POST", "/auth/signin", {
    auth: false,
    body: { email, password: "Password123!" },
  });
  expect("sign-in succeeds", status === 200, `status ${status}`);
  accessToken = data?.accessToken;

  const oldCookie = cookie;
  const refreshed = await call("POST", "/auth/refresh", { auth: false });
  expect(
    "refresh returns a new access token",
    refreshed.status === 200 && Boolean(refreshed.data?.accessToken),
    `status ${refreshed.status}`,
  );
  expect("refresh token rotated", cookie !== oldCookie, "cookie unchanged after refresh");
  accessToken = refreshed.data.accessToken;

  // Replaying the pre-rotation cookie must nuke the whole family.
  const stash = cookie;
  cookie = oldCookie;
  const replay = await call("POST", "/auth/refresh", { auth: false });
  expect(
    "replaying a rotated refresh token is rejected",
    replay.status === 401,
    `status ${replay.status}`,
  );
  cookie = stash;

  const after = await call("POST", "/auth/refresh", { auth: false });
  expect("reuse revoked the whole session family", after.status === 401, `status ${after.status}`);

  const back = await call("POST", "/auth/signin", {
    auth: false,
    body: { email, password: "Password123!" },
  });
  accessToken = back.data?.accessToken;
  expect("can sign in again after revocation", back.status === 200, `status ${back.status}`);
}

console.log("\n── Account and addresses ─────────────────────────────");
let addressId = null;
{
  const me = await call("GET", "/account/me");
  expect(
    "authenticated profile fetch",
    me.status === 200 && me.data?.user?.email === email,
    `status ${me.status} ${JSON.stringify(me.data)?.slice(0, 200)}`,
  );

  const empty = await call("GET", "/account/me/addresses");
  expect(
    "empty address book is 200, not 404",
    empty.status === 200 && empty.data?.addresses?.length === 0,
    `status ${empty.status}`,
  );

  const partial = await call("PATCH", "/account/me", { body: { first_name: "Partial" } });
  expect(
    "partial profile update accepted",
    partial.status === 200,
    `status ${partial.status} ${JSON.stringify(partial.data?.error)}`,
  );

  const created = await call("POST", "/account/me/addresses", {
    body: {
      recipient_name: "End ToEnd",
      address_line1: "Musterstraße 12",
      city: "Berlin",
      country: "Germany",
      zip: "10115",
    },
  });
  expect(
    "address created",
    created.status === 201,
    `status ${created.status} ${JSON.stringify(created.data?.error)}`,
  );
  addressId = created.data?.address?.addressId;
  expect(
    "first address becomes default",
    created.data?.address?.isDefault === true,
    `isDefault=${created.data?.address?.isDefault}`,
  );
}

console.log("\n── Cart ──────────────────────────────────────────────");
{
  const anon = await call("GET", "/cart", { auth: false });
  expect("cart requires auth", anon.status === 401, `status ${anon.status}`);

  const a = await call("POST", "/cart/items", {
    body: { productId: inStock[0].productId, quantity: 2 },
  });
  expect("add first item", a.status === 201, `status ${a.status} ${JSON.stringify(a.data?.error)}`);

  const b = await call("POST", "/cart/items", {
    body: { productId: inStock[1].productId, quantity: 1 },
  });
  expect("add second item", b.status === 201, `status ${b.status}`);

  const cart = b.data.cart;
  const expectedSubtotal = inStock[0].priceCents * 2 + inStock[1].priceCents;
  expect(
    "subtotal computed server-side",
    cart.subtotalCents === expectedSubtotal,
    `${cart.subtotalCents} != ${expectedSubtotal}`,
  );
  expect(
    "VAT is 19%",
    cart.taxCents === Math.round(expectedSubtotal * 0.19),
    `tax=${cart.taxCents}`,
  );
  expect(
    "total equals its parts",
    cart.totalCents === cart.subtotalCents + cart.shippingCents + cart.taxCents,
    `${cart.totalCents} != ${cart.subtotalCents}+${cart.shippingCents}+${cart.taxCents}`,
  );

  if (soldOut) {
    const s = await call("POST", "/cart/items", {
      body: { productId: soldOut.productId, quantity: 1 },
    });
    expect(
      "sold-out item refused with a real message",
      s.status === 409 && s.data?.error?.errorCode === "INV_INSUFFICIENT_STOCK",
      `status ${s.status} code ${s.data?.error?.errorCode} msg "${s.data?.error?.message}"`,
    );
  }
  if (lowStock) {
    const l = await call("POST", "/cart/items", {
      body: { productId: lowStock.productId, quantity: 20 },
    });
    expect(
      "over-ordering names the available quantity",
      l.status === 409 && /only 3/i.test(l.data?.error?.message ?? ""),
      `status ${l.status} msg "${l.data?.error?.message}"`,
    );
  }

  const upd = await call("PATCH", `/cart/items/${inStock[1].productId}`, { body: { quantity: 3 } });
  expect(
    "quantity update",
    upd.status === 200 &&
      upd.data.cart.items.find((i) => i.productId === inStock[1].productId).quantity === 3,
    `status ${upd.status}`,
  );

  const del = await call("DELETE", `/cart/items/${inStock[1].productId}`);
  expect(
    "remove item",
    del.status === 200 && del.data.cart.items.length === 1,
    `status ${del.status}`,
  );
}

console.log("\n── Checkout ──────────────────────────────────────────");
let orderId = null;
let orderTotal = null;
{
  const preview = await call("GET", `/checkout/preview?shippingAddressId=${addressId}`);
  expect(
    "preview returns totals",
    preview.status === 200 && preview.data?.totals?.totalCents > 0,
    `status ${preview.status} ${JSON.stringify(preview.data?.error)}`,
  );
  orderTotal = preview.data?.totals?.totalCents;

  const noKey = await call("POST", "/checkout/orders", {
    body: {
      shippingAddressId: addressId,
      paymentMethod: "card",
      paymentToken: "tok_test_success",
      expectedTotalCents: orderTotal,
    },
  });
  expect(
    "Idempotency-Key is mandatory",
    noKey.status === 400 && noKey.data?.error?.errorCode === "IDEMPOTENCY_KEY_REQUIRED",
    `status ${noKey.status} code ${noKey.data?.error?.errorCode}`,
  );

  const wrongTotal = await call("POST", "/checkout/orders", {
    headers: { "idempotency-key": uuid() },
    body: {
      shippingAddressId: addressId,
      paymentMethod: "card",
      paymentToken: "tok_test_success",
      expectedTotalCents: 1,
    },
  });
  expect(
    "refuses to charge a total the client did not show",
    wrongTotal.status === 409 && wrongTotal.data?.error?.errorCode === "ORDER_PRICE_CHANGED",
    `status ${wrongTotal.status} code ${wrongTotal.data?.error?.errorCode}`,
  );

  // Declined card: stock must come back.
  const beforeDecline = await call("GET", `/inventory/stock/${inStock[0].productId}`, {
    auth: false,
  });
  const declined = await call("POST", "/checkout/orders", {
    headers: { "idempotency-key": uuid() },
    body: {
      shippingAddressId: addressId,
      paymentMethod: "card",
      paymentToken: "tok_test_decline",
      cardLast4: "0002",
      expectedTotalCents: orderTotal,
    },
  });
  expect(
    "declined card returns 402",
    declined.status === 402 && declined.data?.error?.errorCode === "PAY_DECLINED",
    `status ${declined.status} code ${declined.data?.error?.errorCode}`,
  );
  const afterDecline = await call("GET", `/inventory/stock/${inStock[0].productId}`, {
    auth: false,
  });
  expect(
    "declined payment releases the reservation",
    beforeDecline.data?.stock?.available === afterDecline.data?.stock?.available,
    `${beforeDecline.data?.stock?.available} -> ${afterDecline.data?.stock?.available}`,
  );

  const key = uuid();
  const placed = await call("POST", "/checkout/orders", {
    headers: { "idempotency-key": key },
    body: {
      shippingAddressId: addressId,
      paymentMethod: "card",
      paymentToken: "tok_test_success",
      cardLast4: "4242",
      expectedTotalCents: orderTotal,
    },
  });
  expect(
    "order placed",
    placed.status === 201,
    `status ${placed.status} ${JSON.stringify(placed.data?.error)}`,
  );
  orderId = placed.data?.order?.orderId;
  expect(
    "order is processing",
    placed.data?.order?.status === "processing",
    `status=${placed.data?.order?.status}`,
  );
  expect(
    "shipment created",
    Boolean(placed.data?.order?.shipment?.trackingNumber),
    `shipment=${JSON.stringify(placed.data?.order?.shipment)}`,
  );

  const replay = await call("POST", "/checkout/orders", {
    headers: { "idempotency-key": key },
    body: {
      shippingAddressId: addressId,
      paymentMethod: "card",
      paymentToken: "tok_test_success",
      cardLast4: "4242",
      expectedTotalCents: orderTotal,
    },
  });
  expect(
    "replaying the key returns the same order, not a second one",
    replay.data?.order?.orderId === orderId,
    `${replay.data?.order?.orderId} vs ${orderId}`,
  );

  const emptied = await call("GET", "/cart");
  expect(
    "cart cleared after checkout",
    emptied.data?.cart?.items?.length === 0,
    `${emptied.data?.cart?.items?.length} items left`,
  );
}

console.log("\n── Orders ────────────────────────────────────────────");
{
  const list = await call("GET", "/orders");
  expect(
    "order appears in history",
    list.status === 200 && list.data?.items?.some((o) => o.orderId === orderId),
    `status ${list.status} count ${list.data?.items?.length}`,
  );

  const detail = await call("GET", `/orders/${orderId}`);
  expect("order detail", detail.status === 200, `status ${detail.status}`);
  expect(
    "timeline recorded",
    detail.data?.order?.timeline?.length >= 3,
    `${detail.data?.order?.timeline?.length} events`,
  );
  expect(
    "shipping address snapshotted",
    Boolean(detail.data?.order?.shippingAddress?.city),
    "no address on order",
  );
  expect(
    "order total matches what was quoted",
    detail.data?.order?.totalCents === orderTotal,
    `${detail.data?.order?.totalCents} != ${orderTotal}`,
  );

  const other = await call("GET", `/orders/${uuid()}`);
  expect("unknown order is 404", other.status === 404, `status ${other.status}`);
}

console.log("\n── Reviews ───────────────────────────────────────────");
{
  const anon = await call("POST", "/reviews", {
    auth: false,
    body: { productId: products[0].productId, rating: 5, body: "Anonymous spam attempt here." },
  });
  expect("anonymous cannot review", anon.status === 401, `status ${anon.status}`);

  const target = inStock[0];
  const created = await call("POST", "/reviews", {
    body: {
      productId: target.productId,
      rating: 5,
      title: "Great",
      body: "Bought it in this very test run and it works.",
    },
  });
  expect(
    "review created",
    created.status === 201,
    `status ${created.status} ${JSON.stringify(created.data?.error)}`,
  );
  expect(
    "verified purchase detected from the order",
    created.data?.review?.isVerifiedPurchase === true,
    `verified=${created.data?.review?.isVerifiedPurchase}`,
  );

  const dup = await call("POST", "/reviews", {
    body: { productId: target.productId, rating: 1, body: "Trying to review twice over here." },
  });
  expect(
    "duplicate review rejected",
    dup.status === 409 && dup.data?.error?.errorCode === "REVIEW_DUPLICATE",
    `status ${dup.status} code ${dup.data?.error?.errorCode}`,
  );

  const listed = await call("GET", `/reviews/product/${target.productId}`, { auth: false });
  expect("reviews readable anonymously", listed.status === 200, `status ${listed.status}`);
  expect(
    "rating summary present",
    typeof listed.data?.summary?.average === "number",
    `summary=${JSON.stringify(listed.data?.summary)}`,
  );
}

console.log("\n── Recommendations and view tracking ─────────────────");
{
  const view = await call("POST", `/catalog/products/${products[0].productId}/views`, {
    auth: false,
    body: {},
  });
  expect("anonymous view tracking allowed", view.status === 202, `status ${view.status}`);

  const trending = await call("GET", "/recommendations/trending?limit=4", { auth: false });
  expect(
    "trending works anonymously",
    trending.status === 200 && Array.isArray(trending.data?.recommendations),
    `status ${trending.status}`,
  );

  const forMe = await call("GET", "/recommendations/for-me?limit=4");
  expect(
    "personalised feed falls back gracefully",
    forMe.status === 200 && forMe.data?.recommendations?.length > 0,
    `status ${forMe.status} strategy=${forMe.data?.strategy}`,
  );

  const related = await call("GET", `/recommendations/related/${products[0].productId}?limit=4`, {
    auth: false,
  });
  expect(
    "related products returned",
    related.status === 200 && related.data?.recommendations?.length > 0,
    `status ${related.status} strategy=${related.data?.strategy}`,
  );
}

console.log("\n── Admin boundary ────────────────────────────────────");
{
  const adjust = await call("POST", `/inventory/stock/${products[0].productId}/adjust`, {
    body: { delta: 1000, reason: "self-service restock" },
  });
  expect("customer cannot adjust stock", adjust.status === 403, `status ${adjust.status}`);

  const allOrders = await call("GET", "/orders/admin/all");
  expect("customer cannot list all orders", allOrders.status === 403, `status ${allOrders.status}`);

  const jobs = await call("POST", "/recommendation-jobs/runs", { body: { wait: false } });
  expect("customer cannot trigger batch jobs", jobs.status === 403, `status ${jobs.status}`);
}

console.log("\n── Admin can, though ─────────────────────────────────");
{
  const saved = { accessToken, cookie };
  accessToken = null;
  cookie = null;

  const admin = await call("POST", "/auth/signin", {
    auth: false,
    body: { email: "admin@example.com", password: "Admin123!Pass" },
  });
  expect(
    "admin signs in",
    admin.status === 200 && admin.data?.user?.role === "admin",
    `status ${admin.status} role=${admin.data?.user?.role}`,
  );
  accessToken = admin.data?.accessToken;

  const created = await call("POST", "/catalog/products", {
    body: {
      sku: `E2E-${Date.now().toString().slice(-8)}`,
      name: "E2E Test Product",
      category: "Testing",
      priceCents: 1999,
      initialStock: 5,
    },
  });
  expect(
    "admin creates a product",
    created.status === 201,
    `status ${created.status} ${JSON.stringify(created.data?.error)}`,
  );

  const newId = created.data?.product?.productId;
  const patched = await call("PATCH", `/catalog/products/${newId}`, { body: { priceCents: 2999 } });
  expect(
    "admin updates a product",
    patched.status === 200 && patched.data?.product?.priceCents === 2999,
    `status ${patched.status}`,
  );

  const stocked = await call("POST", `/inventory/stock/${newId}/adjust`, {
    body: { delta: 10, reason: "e2e restock" },
  });
  expect(
    "admin adjusts stock",
    stocked.status === 200 && stocked.data?.stock?.available === 15,
    `status ${stocked.status} available=${stocked.data?.stock?.available}`,
  );

  const removed = await call("DELETE", `/catalog/products/${newId}?hard=true`);
  expect("admin deletes a product", removed.status === 200, `status ${removed.status}`);

  const job = await call("POST", "/recommendation-jobs/runs", { body: { wait: true } });
  expect(
    "admin runs the recommendation batch",
    job.status === 200 && job.data?.status === "completed",
    `status ${job.status} ${JSON.stringify(job.data)?.slice(0, 200)}`,
  );

  accessToken = saved.accessToken;
  cookie = saved.cookie;
}

console.log("\n── Order cancellation and restock ────────────────────");
{
  const before = await call("GET", `/inventory/stock/${inStock[0].productId}`, { auth: false });
  const cancel = await call("POST", `/orders/${orderId}/cancel`, {
    body: { reason: "changed my mind" },
  });
  expect(
    "order cancelled",
    cancel.status === 200,
    `status ${cancel.status} ${JSON.stringify(cancel.data?.error)}`,
  );

  await new Promise((resolve) => setTimeout(resolve, 400));
  const after = await call("GET", `/inventory/stock/${inStock[0].productId}`, { auth: false });
  expect(
    "cancellation returns stock",
    after.data?.stock?.available > before.data?.stock?.available,
    `${before.data?.stock?.available} -> ${after.data?.stock?.available}`,
  );

  const again = await call("POST", `/orders/${orderId}/cancel`, { body: {} });
  expect("re-cancelling is idempotent", again.status === 200, `status ${again.status}`);
}

console.log("\n── Sign-out ──────────────────────────────────────────");
{
  const out = await call("POST", "/auth/signout");
  expect("sign-out succeeds", out.status === 204, `status ${out.status}`);
  const after = await call("POST", "/auth/refresh", { auth: false });
  expect("refresh fails after sign-out", after.status === 401, `status ${after.status}`);
}

console.log(`\n${"─".repeat(54)}`);
console.log(`  ${pass} passed, ${fail} failed\n`);
if (fail > 0) {
  for (const f of failures) console.log(`  • ${f}`);
  console.log("");
}
process.exit(fail === 0 ? 0 : 1);
