import { Router } from "express";
import { requireAuth, requireIdempotencyKey, validate } from "@ecom/shared";
import { config } from "./config.js";
import { placeOrderSchema, previewQuerySchema } from "./schemas.js";
import { create, preview } from "./controllers/checkoutController.js";

const authenticate = requireAuth({ secret: config.INTERNAL_JWT_SECRET });

export function buildRouter() {
  const router = Router();
  router.use(authenticate);

  router.get("/preview", validate(previewQuerySchema, "query"), preview);
  router.post("/orders", requireIdempotencyKey, validate(placeOrderSchema), create);

  return router;
}
