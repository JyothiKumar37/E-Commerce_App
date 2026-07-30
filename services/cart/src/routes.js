import { Router } from "express";
import { requireAuth, validate } from "@ecom/shared";
import { config } from "./config.js";
import { addItemSchema, mergeSchema, productIdParam, quantitySchema } from "./schemas.js";
import {
  add,
  clear,
  clearInternal,
  merge,
  remove,
  show,
  updateQuantity,
} from "./controllers/cartController.js";

const authenticate = requireAuth({ secret: config.INTERNAL_JWT_SECRET });

export function buildRouter() {
  const router = Router();
  router.use(authenticate);

  router.get("/", show);
  router.post("/items", validate(addItemSchema), add);
  router.patch(
    "/items/:productId",
    validate(productIdParam, "params"),
    validate(quantitySchema),
    updateQuantity,
  );
  router.delete("/items/:productId", validate(productIdParam, "params"), remove);
  router.delete("/", clear);

  // Folds a guest cart into the account cart right after sign-in.
  router.post("/merge", validate(mergeSchema), merge);

  // --- service-to-service ---------------------------------------------
  router.post("/internal/clear", clearInternal);

  return router;
}
