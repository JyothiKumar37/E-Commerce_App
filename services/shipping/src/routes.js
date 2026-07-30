import { Router } from "express";
import { requireAuth, requireRole, validate } from "@ecom/shared";
import { config } from "./config.js";
import {
  createShipmentSchema,
  orderIdParam,
  quoteSchema,
  shipmentIdParam,
  trackingNumberParam,
  updateShipmentSchema,
} from "./schemas.js";
import {
  createShipment,
  getShipment,
  listShipmentsForOrder,
  quote,
  trackByNumber,
  updateShipmentStatus,
} from "./controllers/shipmentController.js";

const authenticate = requireAuth({ secret: config.INTERNAL_JWT_SECRET });
const adminOnly = [authenticate, requireRole("admin")];

export function buildRouter() {
  const router = Router();
  router.use(authenticate);

  router.post("/quote", validate(quoteSchema), quote);
  router.post("/shipments", validate(createShipmentSchema), createShipment);

  // Registered before /shipments/:shipmentId so "tracking" is not read as a UUID.
  router.get(
    "/shipments/tracking/:trackingNumber",
    validate(trackingNumberParam, "params"),
    trackByNumber,
  );
  router.get("/shipments/:shipmentId", validate(shipmentIdParam, "params"), getShipment);
  router.get("/orders/:orderId/shipments", validate(orderIdParam, "params"), listShipmentsForOrder);

  // Carrier-webhook equivalent.
  router.patch(
    "/shipments/:shipmentId/status",
    ...adminOnly,
    validate(shipmentIdParam, "params"),
    validate(updateShipmentSchema),
    updateShipmentStatus,
  );

  return router;
}
