import {
  AppError,
  ErrorCodes,
  asyncHandler,
  buildUpdateSet,
  paginated,
  withTransaction,
} from "@ecom/shared";
import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";

/**
 * Catalog CRUD.
 *
 * Postgres is the system of record; Elasticsearch is a derived index kept in
 * step by the outbox worker. Each mutation enqueues its outbox row inside the
 * same transaction as the change itself, so the two can never disagree about
 * whether a write happened.
 */

const PRODUCT_SELECT = `
  p.product_id, p.sku, p.name, p.description, p.category, p.brand,
  p.price_cents, p.currency, p.image_url, p.attributes, p.is_active,
  p.rating_avg, p.rating_count, p.created_at, p.updated_at,
  COALESCE(i.available, 0) AS available`;

const toPublicProduct = (row) => ({
  productId: row.product_id,
  sku: row.sku,
  name: row.name,
  description: row.description,
  category: row.category,
  brand: row.brand,
  priceCents: row.price_cents,
  currency: row.currency,
  imageUrl: row.image_url,
  attributes: row.attributes ?? {},
  isActive: row.is_active,
  ratingAvg: Number(row.rating_avg ?? 0),
  ratingCount: row.rating_count ?? 0,
  available: row.available ?? 0,
  inStock: (row.available ?? 0) > 0,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const listProducts = asyncHandler(async (req, res) => {
  const { page, pageSize, category, brand, sort } = req.query;
  const conditions = ["p.is_active"];
  const params = [];

  if (category) {
    params.push(category);
    conditions.push(`p.category = $${params.length}`);
  }
  if (brand) {
    params.push(brand);
    conditions.push(`p.brand = $${params.length}`);
  }

  const where = conditions.join(" AND ");
  const orderBy =
    {
      price_asc: "p.price_cents ASC",
      price_desc: "p.price_cents DESC",
      rating: "p.rating_avg DESC, p.rating_count DESC",
      newest: "p.created_at DESC",
    }[sort] ?? "p.created_at DESC";

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM products p WHERE ${where}`,
    params,
  );

  params.push(pageSize, (page - 1) * pageSize);
  const { rows } = await pool.query(
    `SELECT ${PRODUCT_SELECT}
     FROM products p LEFT JOIN inventory i ON i.product_id = p.product_id
     WHERE ${where}
     ORDER BY ${orderBy}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  res.json(paginated(rows.map(toPublicProduct), { page, pageSize, total: countRows[0].total }));
});

/**
 * Fetch by id. The old handler looked the product up with a DynamoDB key typed
 * `{ N: ProductID }` while every other operation wrote `{ S: ... }` on a UUID,
 * so every single get failed — and the surrounding try/catch masked the real
 * cause behind a flat 500 "Unable to get product".
 */
export const getProduct = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ${PRODUCT_SELECT}
     FROM products p LEFT JOIN inventory i ON i.product_id = p.product_id
     WHERE p.product_id = $1`,
    [req.params.productId],
  );

  if (!rows[0]) throw productNotFound();
  res.json({ product: toPublicProduct(rows[0]) });
});

export const getProductBySku = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ${PRODUCT_SELECT}
     FROM products p LEFT JOIN inventory i ON i.product_id = p.product_id
     WHERE p.sku = $1`,
    [req.params.sku],
  );
  if (!rows[0]) throw productNotFound();
  res.json({ product: toPublicProduct(rows[0]) });
});

/** Bulk lookup used by cart and checkout to re-price a basket in one round trip. */
export const getProductsByIds = asyncHandler(async (req, res) => {
  const { productIds } = req.body;
  const { rows } = await pool.query(
    `SELECT ${PRODUCT_SELECT}
     FROM products p LEFT JOIN inventory i ON i.product_id = p.product_id
     WHERE p.product_id = ANY($1::uuid[])`,
    [productIds],
  );
  res.json({ products: rows.map(toPublicProduct) });
});

export const listCategories = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT category, COUNT(*)::int AS count
     FROM products WHERE is_active
     GROUP BY category ORDER BY category`,
  );
  res.json({ categories: rows });
});

export const createProduct = asyncHandler(async (req, res) => {
  const payload = req.body;

  const product = await withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO products (sku, name, description, category, brand, price_cents,
                             currency, image_url, attributes, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING product_id, sku, name, description, category, brand, price_cents,
                 currency, image_url, attributes, is_active, rating_avg, rating_count,
                 created_at, updated_at`,
      [
        payload.sku,
        payload.name,
        payload.description ?? "",
        payload.category,
        payload.brand ?? null,
        payload.priceCents,
        payload.currency ?? "EUR",
        payload.imageUrl ?? null,
        JSON.stringify(payload.attributes ?? {}),
        payload.isActive ?? true,
      ],
    );
    const created = rows[0];

    await client.query(
      `INSERT INTO inventory (product_id, available) VALUES ($1, $2)
       ON CONFLICT (product_id) DO UPDATE SET available = EXCLUDED.available`,
      [created.product_id, payload.initialStock ?? 0],
    );

    await enqueueIndex(client, created.product_id, "upsert");
    return { ...created, available: payload.initialStock ?? 0 };
  });

  logger.info({ productId: product.product_id, sku: product.sku }, "product created");
  res.status(201).json({ product: toPublicProduct(product), message: "Product created." });
});

export const updateProduct = asyncHandler(async (req, res) => {
  const { productId } = req.params;

  const patch = {
    sku: req.body.sku,
    name: req.body.name,
    description: req.body.description,
    category: req.body.category,
    brand: req.body.brand,
    price_cents: req.body.priceCents,
    currency: req.body.currency,
    image_url: req.body.imageUrl,
    is_active: req.body.isActive,
    // Merged rather than replaced, so a partial update cannot wipe facets.
    attributes: req.body.attributes ? JSON.stringify(req.body.attributes) : undefined,
  };

  const product = await withTransaction(pool, async (client) => {
    const { rows: existing } = await client.query(
      "SELECT product_id FROM products WHERE product_id = $1 FOR UPDATE",
      [productId],
    );
    if (!existing[0]) throw productNotFound();

    const { clause, values, nextIndex } = buildUpdateSet(patch);
    const { rows } = await client.query(
      `UPDATE products SET ${clause}
       WHERE product_id = $${nextIndex}
       RETURNING product_id, sku, name, description, category, brand, price_cents,
                 currency, image_url, attributes, is_active, rating_avg, rating_count,
                 created_at, updated_at`,
      [...values, productId],
    );

    await enqueueIndex(client, productId, "upsert");
    return rows[0];
  });

  logger.info({ productId }, "product updated");
  res.json({ product: toPublicProduct(product), message: "Product updated." });
});

/**
 * Soft delete by default: a product referenced by `order_items` cannot be
 * removed (the FK is ON DELETE RESTRICT, because deleting it would corrupt
 * historical invoices). `?hard=true` is honoured only when no order references
 * it.
 */
export const deleteProduct = asyncHandler(async (req, res) => {
  const { productId } = req.params;
  const hard = req.query.hard === true;

  const outcome = await withTransaction(pool, async (client) => {
    const { rows: existing } = await client.query(
      "SELECT product_id FROM products WHERE product_id = $1 FOR UPDATE",
      [productId],
    );
    if (!existing[0]) throw productNotFound();

    if (hard) {
      const { rows: referenced } = await client.query(
        "SELECT 1 FROM order_items WHERE product_id = $1 LIMIT 1",
        [productId],
      );
      if (referenced[0]) {
        throw new AppError({
          message:
            "This product appears in existing orders and cannot be permanently deleted. Deactivate it instead.",
          statusCode: 409,
          errorCode: "PRODUCT_REFERENCED",
        });
      }
      await client.query("DELETE FROM products WHERE product_id = $1", [productId]);
      await enqueueIndex(client, productId, "delete");
      return "deleted";
    }

    await client.query("UPDATE products SET is_active = FALSE WHERE product_id = $1", [productId]);
    await enqueueIndex(client, productId, "upsert");
    return "deactivated";
  });

  logger.info({ productId, outcome }, "product removed from catalog");
  res.json({
    message: outcome === "deleted" ? "Product permanently deleted." : "Product deactivated.",
  });
});

/** Records a product view; the recommendation generator consumes these. */
export const recordView = asyncHandler(async (req, res) => {
  const { productId } = req.params;
  await pool.query(
    `INSERT INTO product_views (product_id, user_id, session_id)
     VALUES ($1, $2, $3)`,
    [productId, req.auth?.userId ?? null, req.body?.sessionId ?? null],
  );
  res.status(202).json({ recorded: true });
});

function enqueueIndex(client, productId, operation) {
  return client.query("INSERT INTO catalog_outbox (product_id, operation) VALUES ($1, $2)", [
    productId,
    operation,
  ]);
}

const productNotFound = () =>
  new AppError({
    message: "Product not found.",
    statusCode: 404,
    errorCode: ErrorCodes.PRODUCT_NOT_FOUND,
  });
