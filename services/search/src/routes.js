import { Router } from "express";
import { asyncHandler, requireAuth, requireRole, validate } from "@ecom/shared";
import { config } from "./config.js";
import { reindexAll } from "./services/indexer.js";
import { search, suggest } from "./controllers/searchController.js";
import {
  createProduct,
  deleteProduct,
  getProduct,
  getProductBySku,
  getProductsByIds,
  listCategories,
  listProducts,
  recordView,
  updateProduct,
} from "./controllers/productController.js";
import {
  bulkProductsSchema,
  createProductSchema,
  deleteProductQuerySchema,
  listProductsQuerySchema,
  productIdParam,
  recordViewSchema,
  searchSchema,
  skuParam,
  updateProductSchema,
} from "./schemas.js";

const authenticate = requireAuth({ secret: config.INTERNAL_JWT_SECRET });
const optionalAuth = requireAuth({ secret: config.INTERNAL_JWT_SECRET, optional: true });
const adminOnly = [authenticate, requireRole("admin")];

export function buildRouter() {
  const router = Router();

  // --- public reads ---------------------------------------------------
  router.post("/search", optionalAuth, validate(searchSchema), search);
  router.get("/suggest", optionalAuth, suggest);
  router.get("/products", optionalAuth, validate(listProductsQuerySchema, "query"), listProducts);
  router.get("/categories", optionalAuth, listCategories);

  // Registered before /products/:productId so "sku" is not read as a UUID.
  router.get("/products/sku/:sku", optionalAuth, validate(skuParam, "params"), getProductBySku);
  router.post("/products/lookup", optionalAuth, validate(bulkProductsSchema), getProductsByIds);

  router.get("/products/:productId", optionalAuth, validate(productIdParam, "params"), getProduct);
  router.post(
    "/products/:productId/views",
    optionalAuth,
    validate(productIdParam, "params"),
    validate(recordViewSchema),
    recordView,
  );

  // --- catalog writes ---------------------------------------------------
  // Previously every one of these was reachable unauthenticated: /search had
  // no guard at the gateway and this service had no auth middleware at all,
  // so anyone on the internet could rewrite or delete the catalog.
  router.post("/products", ...adminOnly, validate(createProductSchema), createProduct);
  router.patch(
    "/products/:productId",
    ...adminOnly,
    validate(productIdParam, "params"),
    validate(updateProductSchema),
    updateProduct,
  );
  router.delete(
    "/products/:productId",
    ...adminOnly,
    validate(productIdParam, "params"),
    validate(deleteProductQuerySchema, "query"),
    deleteProduct,
  );

  router.post(
    "/admin/reindex",
    ...adminOnly,
    asyncHandler(async (req, res) => {
      res.json({ ...(await reindexAll()), message: "Reindex complete." });
    }),
  );

  return router;
}
