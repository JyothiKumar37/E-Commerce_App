import { Router } from "express";
import { requireAuth, validate } from "@ecom/shared";
import { config } from "./config.js";
import { limitQuery, productIdParam } from "./schemas.js";
import {
  forMe,
  recentlyViewed,
  related,
  trending,
} from "./controllers/recommendationController.js";

const authenticate = requireAuth({ secret: config.INTERNAL_JWT_SECRET });
const optionalAuth = requireAuth({ secret: config.INTERNAL_JWT_SECRET, optional: true });

export function buildRouter() {
  const router = Router();

  // Anonymous visitors still get a populated shelf, just an unpersonalised one.
  router.get("/for-me", optionalAuth, validate(limitQuery, "query"), forMe);
  router.get("/trending", optionalAuth, validate(limitQuery, "query"), trending);
  router.get(
    "/related/:productId",
    optionalAuth,
    validate(productIdParam, "params"),
    validate(limitQuery, "query"),
    related,
  );

  // Requires an identity by definition.
  router.get("/recently-viewed", authenticate, validate(limitQuery, "query"), recentlyViewed);

  return router;
}
