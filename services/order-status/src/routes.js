import { Router } from "express";
import { requireAuth, requireRole, validate } from "@ecom/shared";
import { config } from "./config.js";
import {
  cancelSchema,
  listQuerySchema,
  orderIdParam,
  orderNumberParam,
  updateStatusSchema,
} from "./schemas.js";
import {
  cancelOrder,
  getOrder,
  getOrderByNumber,
  listAllOrders,
  listOrders,
  updateStatus,
} from "./controllers/orderController.js";

const authenticate = requireAuth({ secret: config.INTERNAL_JWT_SECRET });
const adminOnly = [authenticate, requireRole("admin")];

export function buildRouter() {
  const router = Router();
  router.use(authenticate);

  router.get("/", validate(listQuerySchema, "query"), listOrders);

  // Registered before /:orderId so "admin" is not parsed as a UUID.
  router.get("/admin/all", ...adminOnly, validate(listQuerySchema, "query"), listAllOrders);
  router.get("/number/:orderNumber", validate(orderNumberParam, "params"), getOrderByNumber);

  router.get("/:orderId", validate(orderIdParam, "params"), getOrder);
  router.post(
    "/:orderId/cancel",
    validate(orderIdParam, "params"),
    validate(cancelSchema),
    cancelOrder,
  );
  router.patch(
    "/:orderId/status",
    ...adminOnly,
    validate(orderIdParam, "params"),
    validate(updateStatusSchema),
    updateStatus,
  );

  return router;
}
