import { asyncHandler, paginated } from "@ecom/shared";
import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { INDEX, elasticClient } from "../lib/elastic.js";

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

  const filters = [{ term: { isActive: true } }];
  if (category) filters.push({ terms: { category: asArray(category) } });
  if (brand) filters.push({ terms: { brand: asArray(brand) } });
  if (inStock === true) filters.push({ term: { inStock: true } });
  if (minRating != null) filters.push({ range: { ratingAvg: { gte: minRating } } });
  if (minPrice != null || maxPrice != null) {
    filters.push({
      range: {
        priceCents: {
          ...(minPrice != null ? { gte: Math.round(minPrice * 100) } : {}),
          ...(maxPrice != null ? { lte: Math.round(maxPrice * 100) } : {}),
        },
      },
    });
  }

  const query = q.trim()
    ? {
        bool: {
          must: [
            {
              multi_match: {
                query: q,
                fields: ["name^4", "brand^2", "category^2", "description"],
                fuzziness: "AUTO",
                prefix_length: 2,
                operator: "and",
              },
            },
          ],
          // Boost well-reviewed and in-stock items without excluding others.
          should: [
            { term: { inStock: { value: true, boost: 1.5 } } },
            { range: { ratingAvg: { gte: 4, boost: 1.2 } } },
          ],
          filter: filters,
        },
      }
    : { bool: { filter: filters } };

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
    logger.error(
      { err: { message: err.message } },
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

function buildSort(sort, q) {
  switch (sort) {
    case "price_asc":
      return [{ priceCents: "asc" }];
    case "price_desc":
      return [{ priceCents: "desc" }];
    case "rating":
      return [{ ratingAvg: "desc" }, { ratingCount: "desc" }];
    case "newest":
      return [{ createdAt: "desc" }];
    default:
      // With no query text there is no relevance signal, so fall back to
      // something stable rather than returning results in Lucene doc order.
      return q.trim() ? ["_score", { ratingCount: "desc" }] : [{ createdAt: "desc" }];
  }
}

const bucketsOf = (agg) => (agg?.buckets ?? []).map((b) => ({ value: b.key, count: b.doc_count }));

const asArray = (value) => (Array.isArray(value) ? value : [value]);

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
  if (category) {
    params.push(asArray(category));
    conditions.push(`p.category = ANY($${params.length}::text[])`);
  }
  if (brand) {
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
