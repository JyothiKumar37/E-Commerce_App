import { Router } from "express";
import { Joi, requireAuth, requireRole, validate } from "@ecom/shared";
import { config } from "./config.js";
import {
  createReviewSchema,
  listQuerySchema,
  productIdParam,
  reviewIdParam,
  updateReviewSchema,
} from "./schemas.js";
import {
  createReview,
  deleteReview,
  listForProduct,
  listMine,
  markHelpful,
  moderateReview,
  updateReview,
} from "./controllers/reviewController.js";

const authenticate = requireAuth({ secret: config.INTERNAL_JWT_SECRET });
const optionalAuth = requireAuth({ secret: config.INTERNAL_JWT_SECRET, optional: true });
const adminOnly = [authenticate, requireRole("admin")];

const moderateSchema = Joi.object({
  status: Joi.string().valid("published", "pending", "rejected").required(),
});

export function buildRouter() {
  const router = Router();

  // Registered before any /:reviewId route so "mine" is not read as a UUID.
  router.get("/mine", authenticate, listMine);

  // Reading reviews is public; the viewer's identity, when present, only marks
  // which review is their own.
  router.get(
    "/product/:productId",
    optionalAuth,
    validate(productIdParam, "params"),
    validate(listQuerySchema, "query"),
    listForProduct,
  );

  router.post("/", authenticate, validate(createReviewSchema), createReview);
  router.patch(
    "/:reviewId",
    authenticate,
    validate(reviewIdParam, "params"),
    validate(updateReviewSchema),
    updateReview,
  );
  router.delete("/:reviewId", authenticate, validate(reviewIdParam, "params"), deleteReview);
  router.post("/:reviewId/helpful", authenticate, validate(reviewIdParam, "params"), markHelpful);

  router.patch(
    "/:reviewId/moderate",
    ...adminOnly,
    validate(reviewIdParam, "params"),
    validate(moderateSchema),
    moderateReview,
  );

  return router;
}
