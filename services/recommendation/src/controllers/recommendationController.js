import { asyncHandler } from "@ecom/shared";
import { pool } from "../lib/db.js";

const PRODUCT_FIELDS = `
  p.product_id, p.sku, p.name, p.category, p.brand, p.price_cents, p.currency,
  p.image_url, p.rating_avg, p.rating_count,
  COALESCE(i.available, 0) > 0 AS in_stock`;

const toCard = (row) => ({
  productId: row.product_id,
  sku: row.sku,
  name: row.name,
  category: row.category,
  brand: row.brand,
  priceCents: row.price_cents,
  currency: row.currency,
  imageUrl: row.image_url,
  ratingAvg: Number(row.rating_avg ?? 0),
  ratingCount: row.rating_count ?? 0,
  inStock: row.in_stock,
  reason: row.reason ?? undefined,
  score: row.score != null ? Number(row.score) : undefined,
});

/**
 * Personalised feed, with a graceful cascade:
 *   1. precomputed user recommendations
 *   2. items related to what the user recently viewed
 *   3. globally popular items
 *
 * An anonymous visitor or a brand-new account therefore still sees a populated
 * shelf rather than an empty one.
 */
export const forMe = asyncHandler(async (req, res) => {
  const { limit } = req.query;
  const userId = req.auth?.userId ?? null;

  if (userId) {
    const { rows } = await pool.query(
      `SELECT ${PRODUCT_FIELDS}, ur.score, ur.reason
       FROM user_recommendations ur
       JOIN products p ON p.product_id = ur.product_id
       LEFT JOIN inventory i ON i.product_id = p.product_id
       WHERE ur.user_id = $1 AND p.is_active
       ORDER BY ur.score DESC
       LIMIT $2`,
      [userId, limit],
    );
    if (rows.length >= Math.min(4, limit)) {
      return res.json({ recommendations: rows.map(toCard), strategy: "personalised" });
    }
  }

  const popular = await fetchPopular(limit);
  return res.json({
    recommendations: popular.map(toCard),
    strategy: userId ? "popular_fallback" : "popular",
  });
});

/** "Customers who bought this also bought" for a product detail page. */
export const related = asyncHandler(async (req, res) => {
  const { productId } = req.params;
  const { limit } = req.query;

  const { rows } = await pool.query(
    `SELECT ${PRODUCT_FIELDS}, pa.score, 'bought_together' AS reason
     FROM product_affinity pa
     JOIN products p ON p.product_id = pa.related_id
     LEFT JOIN inventory i ON i.product_id = p.product_id
     WHERE pa.product_id = $1 AND p.is_active
     ORDER BY pa.score DESC
     LIMIT $2`,
    [productId, limit],
  );

  if (rows.length >= Math.min(4, limit)) {
    return res.json({ recommendations: rows.map(toCard), strategy: "affinity" });
  }

  // Not enough co-purchase signal yet: fall back to the same category,
  // excluding both the product itself and anything already returned.
  const excluded = [productId, ...rows.map((r) => r.product_id)];
  const { rows: sameCategory } = await pool.query(
    `SELECT ${PRODUCT_FIELDS}, NULL::numeric AS score, 'same_category' AS reason
     FROM products p
     LEFT JOIN inventory i ON i.product_id = p.product_id
     WHERE p.is_active
       AND p.category = (SELECT category FROM products WHERE product_id = $1)
       AND p.product_id <> ALL($2::uuid[])
     ORDER BY p.rating_avg DESC, p.rating_count DESC
     LIMIT $3`,
    [productId, excluded, limit - rows.length],
  );

  const picks = [...rows, ...sameCategory];
  if (picks.length > 0) {
    return res.json({
      recommendations: picks.map(toCard),
      strategy: rows.length ? "affinity_padded" : "same_category",
    });
  }

  // Last resort: the best-rated products overall.
  //
  // Both queries above can legitimately return nothing. A product that is the
  // only one in its category has no same-category neighbours once itself is
  // excluded, and with no co-purchase history there is no affinity either — so
  // the detail page rendered an empty "related" rail with no explanation.
  //
  // Something generic beats nothing at all here: the rail exists to keep a
  // visitor moving through the catalogue, and any active product does that
  // better than blank space.
  const { rows: popular } = await pool.query(
    `SELECT ${PRODUCT_FIELDS}, NULL::numeric AS score, 'popular' AS reason
     FROM products p
     LEFT JOIN inventory i ON i.product_id = p.product_id
     WHERE p.is_active AND p.product_id <> $1
     ORDER BY p.rating_avg DESC NULLS LAST, p.rating_count DESC
     LIMIT $2`,
    [productId, limit],
  );

  return res.json({ recommendations: popular.map(toCard), strategy: "popular" });
});

/** Trending: view velocity over the last 7 days. */
export const trending = asyncHandler(async (req, res) => {
  const { limit } = req.query;
  const { rows } = await pool.query(
    `SELECT ${PRODUCT_FIELDS}, COUNT(pv.view_id)::numeric AS score, 'trending' AS reason
     FROM products p
     LEFT JOIN inventory i ON i.product_id = p.product_id
     JOIN product_views pv ON pv.product_id = p.product_id
     WHERE p.is_active AND pv.viewed_at > NOW() - INTERVAL '7 days'
     GROUP BY p.product_id, i.available
     ORDER BY COUNT(pv.view_id) DESC, p.rating_avg DESC
     LIMIT $1`,
    [limit],
  );

  if (rows.length === 0) {
    const popular = await fetchPopular(limit);
    return res.json({ recommendations: popular.map(toCard), strategy: "popular" });
  }
  return res.json({ recommendations: rows.map(toCard), strategy: "trending" });
});

/** Recently viewed, for the "pick up where you left off" shelf. */
export const recentlyViewed = asyncHandler(async (req, res) => {
  const { limit } = req.query;
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (p.product_id) ${PRODUCT_FIELDS},
            NULL::numeric AS score, 'recently_viewed' AS reason, pv.viewed_at
     FROM product_views pv
     JOIN products p ON p.product_id = pv.product_id
     LEFT JOIN inventory i ON i.product_id = p.product_id
     WHERE pv.user_id = $1 AND p.is_active
     ORDER BY p.product_id, pv.viewed_at DESC`,
    [req.auth.userId],
  );

  const sorted = rows.sort((a, b) => new Date(b.viewed_at) - new Date(a.viewed_at)).slice(0, limit);

  res.json({ recommendations: sorted.map(toCard), strategy: "recently_viewed" });
});

async function fetchPopular(limit) {
  const { rows } = await pool.query(
    `SELECT ${PRODUCT_FIELDS},
            (p.rating_avg * LN(p.rating_count + 1))::numeric AS score,
            'popular' AS reason
     FROM products p
     LEFT JOIN inventory i ON i.product_id = p.product_id
     WHERE p.is_active AND COALESCE(i.available, 0) > 0
     ORDER BY score DESC, p.created_at DESC
     LIMIT $1`,
    [limit],
  );
  return rows;
}
