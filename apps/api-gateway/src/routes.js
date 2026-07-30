import { Router } from "express";
import { TOKEN_AUDIENCE, requireAuth, requireRole, validate } from "@ecom/shared";
import { config } from "./config.js";
import { createProxy } from "./lib/proxy.js";
import { signInSchema, signUpSchema } from "./schemas.js";
import { me, refresh, signIn, signOut, signOutAll, signUp } from "./controllers/authController.js";

/** Guard for browser-issued access tokens. */
export const authenticate = requireAuth({
  secret: config.JWT_SECRET,
  audience: TOKEN_AUDIENCE.CLIENT,
});

/** Same, but anonymous callers pass through with `req.auth === null`. */
export const authenticateOptional = requireAuth({
  secret: config.JWT_SECRET,
  audience: TOKEN_AUDIENCE.CLIENT,
  optional: true,
});

export function buildAuthRouter({ authLimiter }) {
  const router = Router();

  router.post("/signup", authLimiter, validate(signUpSchema), signUp);
  router.post("/signin", authLimiter, validate(signInSchema), signIn);
  router.post("/refresh", refresh);
  router.post("/signout", signOut);
  router.post("/signout-all", authenticate, signOutAll);
  router.get("/me", authenticate, me);

  return router;
}

/**
 * The routing table, declared as data.
 *
 * `auth` is one of:
 *   "required" — a valid access token must be present
 *   "optional" — anonymous allowed; identity forwarded when present
 *   "admin"    — valid token with the admin role
 *
 * Writes to the catalog were previously reachable by anyone, because /search
 * carried no guard at the gateway and the search service had none of its own.
 * Read and write now differ in policy, which is why `methodAuth` exists.
 */
export const ROUTE_TABLE = [
  { path: "/account", target: config.ACCOUNT_SERVICE_URL, name: "account", auth: "required" },
  { path: "/cart", target: config.CART_SERVICE_URL, name: "cart", auth: "required" },
  {
    path: "/inventory",
    target: config.INVENTORY_SERVICE_URL,
    name: "inventory",
    auth: "optional",
    // Anyone may read stock levels; only admins may adjust them.
    methodAuth: { POST: "admin", PUT: "admin", PATCH: "admin", DELETE: "admin" },
  },
  {
    path: "/orders",
    target: config.ORDER_STATUS_SERVICE_URL,
    name: "order-status",
    auth: "required",
  },
  { path: "/payments", target: config.PAYMENT_SERVICE_URL, name: "payment", auth: "required" },
  {
    path: "/checkout",
    target: config.PLACE_ORDER_SERVICE_URL,
    name: "place-order",
    auth: "required",
  },
  {
    path: "/reviews",
    target: config.PRODUCT_REVIEW_SERVICE_URL,
    name: "product-review",
    auth: "optional",
    methodAuth: { POST: "required", PUT: "required", PATCH: "required", DELETE: "required" },
  },
  {
    path: "/recommendations",
    target: config.RECOMMENDATION_SERVICE_URL,
    name: "recommendation",
    auth: "optional",
  },
  {
    path: "/recommendation-jobs",
    target: config.RECOMMENDATION_GENERATION_SERVICE_URL,
    name: "recommendation-generation",
    auth: "admin",
  },
  {
    path: "/catalog",
    target: config.SEARCH_SERVICE_URL,
    name: "search",
    auth: "optional",
    methodAuth: { POST: "admin", PUT: "admin", PATCH: "admin", DELETE: "admin" },
  },
  { path: "/shipping", target: config.SHIPPING_SERVICE_URL, name: "shipping", auth: "required" },
];

/**
 * POSTs that must stay public even where POST is otherwise admin-only —
 * searching the catalog, and recording a product view.
 *
 * These are patterns, not exact strings: the view path carries a product id
 * (`/products/<uuid>/views`), so a `Set.has(req.path)` lookup would never match
 * it and every anonymous view-tracking call would 403.
 *
 * Listed explicitly rather than inferred, so making a route public is always a
 * deliberate edit.
 */
const PUBLIC_POST_PATTERNS = [/^\/search\/?$/, /^\/products\/[^/]+\/views\/?$/];

export const isPublicPost = (path) => PUBLIC_POST_PATTERNS.some((pattern) => pattern.test(path));

export function mountRoutes(app) {
  for (const route of ROUTE_TABLE) {
    const proxy = createProxy({ name: route.name, baseURL: route.target });
    app.use(route.path, buildGuard(route), proxy);
  }
}

function buildGuard(route) {
  const adminGuards = [authenticate, requireRole("admin")];

  return (req, res, next) => {
    const method = req.method.toUpperCase();

    if (method === "POST" && isPublicPost(req.path)) {
      return authenticateOptional(req, res, next);
    }

    const policy = route.methodAuth?.[method] ?? route.auth;

    if (policy === "admin") return runChain(adminGuards, req, res, next);
    if (policy === "required") return authenticate(req, res, next);
    return authenticateOptional(req, res, next);
  };
}

function runChain(middlewares, req, res, next) {
  let index = 0;
  const step = (err) => {
    if (err) return next(err);
    const middleware = middlewares[index++];
    if (!middleware) return next();
    return middleware(req, res, step);
  };
  return step();
}
