import { Router } from "express";
import { requireAuth, requireRole, validate } from "@ecom/shared";
import { config } from "./config.js";
import {
  adjustSchema,
  productIdParam,
  reservationIdParam,
  reserveSchema,
  restockSchema,
  stockQuerySchema,
} from "./schemas.js";
import {
  adjust,
  commitReservation,
  createReservation,
  getStockForProduct,
  listLowStock,
  listStock,
  releaseReservation,
  restockItems,
  sweep,
} from "./controllers/inventoryController.js";

const authenticate = requireAuth({ secret: config.INTERNAL_JWT_SECRET });
const optionalAuth = requireAuth({ secret: config.INTERNAL_JWT_SECRET, optional: true });
const adminOnly = [authenticate, requireRole("admin")];

export function buildRouter() {
  const router = Router();

  // --- public reads ---------------------------------------------------
  // The storefront shows stock on every product card.
  router.get("/stock", optionalAuth, validate(stockQuerySchema, "query"), listStock);
  router.get(
    "/stock/:productId",
    optionalAuth,
    validate(productIdParam, "params"),
    getStockForProduct,
  );

  // --- reservation lifecycle (driven by place-order) -------------------
  router.post("/reservations", authenticate, validate(reserveSchema), createReservation);
  router.post(
    "/reservations/:reservationId/commit",
    authenticate,
    validate(reservationIdParam, "params"),
    commitReservation,
  );
  router.post(
    "/reservations/:reservationId/release",
    authenticate,
    validate(reservationIdParam, "params"),
    releaseReservation,
  );

  // --- service-to-service ----------------------------------------------
  // Returning stock after a cancellation needs a valid internal token but not
  // the admin role: a service quietly escalating itself to admin would make
  // the authorisation model meaningless.
  router.post("/internal/restock", authenticate, validate(restockSchema), restockItems);

  // --- operator ---------------------------------------------------------
  router.post(
    "/stock/:productId/adjust",
    ...adminOnly,
    validate(productIdParam, "params"),
    validate(adjustSchema),
    adjust,
  );
  router.get("/low-stock", ...adminOnly, listLowStock);
  router.post("/admin/sweep", ...adminOnly, sweep);

  return router;
}
