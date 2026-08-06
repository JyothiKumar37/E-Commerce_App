import { asyncHandler, paginated } from "@ecom/shared";
import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { INDEX, elasticClient } from "../lib/elastic.js";
import { asArray, buildQuery, buildSort, hasValue } from "../lib/query.js";

/**
 * Product search.
 *
 * Improvements over the original single `match` on `ItemDescription`:
 *   - multi_match across name/description/brand/category with field boosts
 *   - fuzziness so "headphnes" still finds headphones
 *   - filters (category, brand, price range, in-stock, rating)
 *   - sorting and real pagination
 *   - aggregations, so the UI can render facet counts
 *   - a Postgres trigram fallback when Elasticsearch is unavailable, so search
 *     degrades instead of returning a 500
 */
export const search = asyncHandler(async (req, res) => {
  const {
    q = "",
    category,
    brand,
    minPrice,
    maxPrice,
    inStock,
    minRating,
    sort = "relevance",
    page,
    pageSize,
  } = req.body;

  const from = (page - 1) * pageSize;

  const query = buildQuery({ q, category, brand, minPrice, maxPrice, inStock, minRating });

  try {
    const response = await elasticClient.search({
      index: INDEX,
      from,
      size: pageSize,
      track_total_hits: true,
      query,
      sort: buildSort(sort, q),
      aggs: {
        categories: { terms: { field: "category", size: 30 } },
        brands: { terms: { field: "brand", size: 30 } },
        priceStats: { stats: { field: "priceCents" } },
      },
    });

    const total = response.hits.total?.value ?? 0;

    return res.json({
      ...paginated(
        response.hits.hits.map((hit) => hit._source),
        { page, pageSize, total },
      ),
      facets: {
        categories: bucketsOf(response.aggregations?.categories),
        brands: bucketsOf(response.aggregations?.brands),
        price: response.aggregations?.priceStats
          ? {
              minCents: response.aggregations.priceStats.min ?? 0,
              maxCents: response.aggregations.priceStats.max ?? 0,
            }
          : null,
      },
      degraded: false,
    });
  } catch (err) {
    // Search being down must not take the storefront down with it.
    //
    // The Elasticsearch client puts the useful part of a failure in
    // `meta.body.error` — the type, the reason and, for a query-shape mistake,
    // the offending clause. Logging only `err.message` reduced all of that to
    // "search_phase_execution_exception", which says a query failed but not
    // which one or why, and turned every index or mapping problem into a silent
    // downgrade to the SQL path.
    const cause = err?.meta?.body?.error;
    logger.error(
      {
        err: {
          message: err.message,
          status: err?.meta?.statusCode,
          type: cause?.type,
          reason: cause?.reason,
          causedBy: cause?.caused_by?.reason,
          failedShards: cause?.failed_shards?.slice(0, 2),
        },
      },
      "elasticsearch query failed; using SQL fallback",
    );
    const fallback = await searchViaPostgres({
      q,
      category,
      brand,
      minPrice,
      maxPrice,
      inStock,
      minRating,
      sort,
      page,
      pageSize,
    });
    return res.json({ ...fallback, degraded: true });
  }
});

/** Type-ahead suggestions backed by the `search_as_you_type` subfield. */
export const suggest = asyncHandler(async (req, res) => {
  const q = (req.query.q ?? "").trim();
  if (q.length < 2) return res.json({ suggestions: [] });

  try {
    const response = await elasticClient.search({
      index: INDEX,
      size: 8,
      _source: ["productId", "name", "category", "priceCents", "imageUrl"],
      query: {
        bool: {
          filter: [{ term: { isActive: true } }],
          must: [
            {
              multi_match: {
                query: q,
                type: "bool_prefix",
                fields: ["name.suggest", "name.suggest._2gram", "name.suggest._3gram"],
              },
            },
          ],
        },
      },
    });
    return res.json({ suggestions: response.hits.hits.map((hit) => hit._source) });
  } catch (err) {
    logger.warn({ err: { message: err.message } }, "suggest failed");
    return res.json({ suggestions: [] });
  }
});

const bucketsOf = (agg) => (agg?.buckets ?? []).map((b) => ({ value: b.key, count: b.doc_count }));

/**
 * Degraded search path: trigram similarity on name plus a plain ILIKE on the
 * description, using the GIN indexes created in migration 001.
 */
async function searchViaPostgres({
  q,
  category,
  brand,
  minPrice,
  maxPrice,
  inStock,
  minRating,
  sort,
  page,
  pageSize,
}) {
  const conditions = ["p.is_active"];
  const params = [];

  if (q?.trim()) {
    params.push(`%${q.trim()}%`);
    conditions.push(`(p.name ILIKE $${params.length} OR p.description ILIKE $${params.length})`);
  }
  // hasValue, not truthiness: an empty array is truthy in JavaScript, and
  // `= ANY('{}')` matches no rows — so the degraded path would return nothing
  // for exactly the requests the storefront sends, where an unselected facet
  // arrives as []. Same defect as the Elasticsearch filters, same fix.
  if (hasValue(category)) {
    params.push(asArray(category));
    conditions.push(`p.category = ANY($${params.length}::text[])`);
  }
  if (hasValue(brand)) {
    params.push(asArray(brand));
    conditions.push(`p.brand = ANY($${params.length}::text[])`);
  }
  if (minPrice != null) {
    params.push(Math.round(minPrice * 100));
    conditions.push(`p.price_cents >= $${params.length}`);
  }
  if (maxPrice != null) {
    params.push(Math.round(maxPrice * 100));
    conditions.push(`p.price_cents <= $${params.length}`);
  }
  if (minRating != null) {
    params.push(minRating);
    conditions.push(`p.rating_avg >= $${params.length}`);
  }
  if (inStock === true) conditions.push("COALESCE(i.available, 0) > 0");

  const where = conditions.join(" AND ");
  const orderBy =
    {
      price_asc: "p.price_cents ASC",
      price_desc: "p.price_cents DESC",
      rating: "p.rating_avg DESC, p.rating_count DESC",
      newest: "p.created_at DESC",
    }[sort] ?? "p.created_at DESC";

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM products p LEFT JOIN inventory i ON i.product_id = p.product_id
     WHERE ${where}`,
    params,
  );

  params.push(pageSize, (page - 1) * pageSize);
  const { rows } = await pool.query(
    `SELECT p.product_id, p.sku, p.name, p.description, p.category, p.brand,
            p.price_cents, p.currency, p.image_url, p.rating_avg, p.rating_count,
            p.attributes, p.created_at, p.updated_at,
            COALESCE(i.available, 0) > 0 AS in_stock
     FROM products p LEFT JOIN inventory i ON i.product_id = p.product_id
     WHERE ${where}
     ORDER BY ${orderBy}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  const items = rows.map((row) => ({
    productId: row.product_id,
    sku: row.sku,
    name: row.name,
    description: row.description,
    category: row.category,
    brand: row.brand,
    priceCents: row.price_cents,
    currency: row.currency,
    imageUrl: row.image_url,
    ratingAvg: Number(row.rating_avg),
    ratingCount: row.rating_count,
    inStock: row.in_stock,
    attributes: row.attributes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

  return {
    ...paginated(items, { page, pageSize, total: countRows[0].total }),
    facets: { categories: [], brands: [], price: null },
  };
}
