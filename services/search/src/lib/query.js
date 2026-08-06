/**
 * Elasticsearch query construction.
 *
 * Deliberately its own module with no imports: `lib/elastic.js` builds a client
 * and `lib/db.js` a connection pool at import time, so anything that pulls in
 * the controller needs a live cluster and database just to be loaded. Keeping
 * the query shapes here makes them testable on their own, which is what the
 * search bug that shipped to production needed and did not have.
 */

/**
 * The free-text half of a product search.
 *
 * The previous version was a single `multi_match` with `operator: "and"` over
 * `["name^4", "brand^2", "category^2", "description"]`. It had three faults:
 *
 *   1. `best_fields` (the default) with `operator: "and"` requires every term
 *      to appear in ONE field. "Northwind hoodie" matched nothing, because the
 *      brand lives in `brand` and the rest in `name`.
 *   2. `brand` and `category` were bare `keyword` fields. A `match` against a
 *      keyword compares the whole query string to the whole field value, so
 *      those two boosts contributed nothing at all — searching "northwind"
 *      could not match a brand stored as "Northwind", not even by case. They
 *      now target the `.text` subfields added to the mapping.
 *   3. `fuzziness` applied to every AND-ed clause, so one unlucky edit-distance
 *      collision could drop a document that matched exactly.
 *
 * The replacement is a `should` of three graded strategies. Exact outranks
 * fuzzy, and `minimum_should_match: 1` means any single strategy suffices.
 */
export function buildTextQuery(q) {
  return {
    must: [
      {
        bool: {
          should: [
            // Whole query as a phrase on the name: the strongest signal there
            // is, and what makes searching a full product name land it first.
            { match_phrase: { name: { query: q, boost: 6 } } },

            // Terms spread across fields. `cross_fields` treats them as one
            // combined field, which is what makes a brand-plus-product search
            // work. 75% rather than 100% so one stray word — a colour the
            // catalogue does not record, say — does not zero the result.
            {
              multi_match: {
                query: q,
                type: "cross_fields",
                fields: ["name^4", "brand.text^3", "category.text^2", "description"],
                operator: "or",
                minimum_should_match: "75%",
              },
            },

            // Typo tolerance, last and lowest. `prefix_length` keeps the term
            // dictionary scan bounded; fuzziness is absent from the strategies
            // above so it can never displace an exact match.
            {
              multi_match: {
                query: q,
                type: "best_fields",
                fields: ["name^2", "brand.text", "description"],
                fuzziness: "AUTO",
                prefix_length: 2,
                max_expansions: 30,
                minimum_should_match: "60%",
              },
            },
          ],
          minimum_should_match: 1,
        },
      },
    ],
    // Boost well-reviewed and in-stock items without excluding others.
    should: [
      { term: { inStock: { value: true, boost: 1.5 } } },
      { range: { ratingAvg: { gte: 4, boost: 1.2 } } },
    ],
  };
}

/**
 * Structured filters. Every one is a `filter` clause rather than a `must`:
 * filters are not scored and are cached by Elasticsearch, and a price range has
 * no business influencing relevance.
 */
export function buildFilters({ category, brand, minPrice, maxPrice, inStock, minRating }) {
  const filters = [{ term: { isActive: true } }];

  // `.folded` carries a lowercasing normalizer, which Elasticsearch applies to
  // the query terms as well as the stored ones. Facet links send back the exact
  // value and match; a hand-edited ?category=apparel now matches too, where the
  // bare keyword field demanded the precise casing.
  //
  // `hasValue`, not a bare truthiness test. The storefront builds these from
  // `searchParams.getAll("category")`, which returns [] when nothing is
  // selected — and [] is truthy in JavaScript. `if (category)` therefore passed
  // for "no category chosen" and emitted `terms: { category: [] }`, a filter
  // that matches no document at all.
  //
  // Every search from the storefront was silently narrowed to nothing, while
  // the same query sent by curl — which simply omits the key — returned
  // results. That divergence is why this survived a green test suite: the e2e
  // never sent the field, so it never built the empty filter.
  if (hasValue(category)) filters.push({ terms: { "category.folded": asArray(category) } });
  if (hasValue(brand)) filters.push({ terms: { "brand.folded": asArray(brand) } });
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

  return filters;
}

/** Combines the two halves into the query Elasticsearch receives. */
export function buildQuery({ q = "", ...rest }) {
  const filters = buildFilters(rest);
  const text = q.trim();
  return text
    ? { bool: { ...buildTextQuery(text), filter: filters } }
    : { bool: { filter: filters } };
}

export function buildSort(sort, q) {
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

export const asArray = (value) => (Array.isArray(value) ? value : [value]);

/**
 * Whether a filter was actually supplied.
 *
 * An empty array and an empty string both mean "the user chose nothing", and
 * both are values a form or a query string produces naturally. Neither may
 * become a filter clause: an empty `terms` matches no documents, and an empty
 * `= ANY('{}')` matches no rows.
 */
export const hasValue = (value) =>
  Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== "";
