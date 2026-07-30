import { Router } from "express";
import { requireAuth, requireRole, validate } from "@ecom/shared";
import { config } from "./config.js";
import { chargeSchema, paymentIdParam } from "./schemas.js";
import {
  charge,
  getPayment,
  listPayments,
  refundPayment,
} from "./controllers/paymentController.js";

const authenticate = requireAuth({ secret: config.INTERNAL_JWT_SECRET });
const adminOnly = [authenticate, requireRole("admin")];

export function buildRouter() {
  const router = Router();
  router.use(authenticate);

  router.post("/charges", validate(chargeSchema), charge);
  router.get("/", listPayments);
  router.get("/:paymentId", validate(paymentIdParam, "params"), getPayment);
  router.post(
    "/:paymentId/refund",
    ...adminOnly,
    validate(paymentIdParam, "params"),
    refundPayment,
  );

  return router;
}
