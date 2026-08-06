/**
 * The product index definition.
 *
 * Kept separate from `elastic.js` for the same reason as `query.js`: that
 * module constructs a client at import time, so anything importing it needs a
 * reachable cluster. A mapping is a pure value and belongs somewhere a test can
 * read it.
 */

/**
 * Bump on any change to the settings below.
 *
 * The version is written into the index's `_meta` and compared on every boot.
 * Without it `ensureIndex` had no way to tell a correctly-built index from a
 * stale one, so it took the only option available — "exists, therefore fine" —
 * and any mapping fix was dead on arrival for every cluster already running.
 */
export const MAPPING_VERSION = 2;

/**
 * Two analyzers, not one. Synonyms belong at search time only:
 *
 *   - `synonym_graph` is the filter that handles multi-word synonyms correctly
 *     ("t-shirt" is two tokens under the standard tokenizer), and Elasticsearch
 *     permits it *only* as a search analyzer.
 *   - The plain `synonym` filter previously shared between both phases cannot
 *     represent a multi-token expansion. It stacks the pieces at one position
 *     and corrupts the position graph for the rest of the stream, which turns
 *     an `operator: and` query into one demanding terms at positions that do
 *     not exist. The symptom is an exact product-name search returning nothing.
 *   - Keeping synonyms out of the index also makes the list a search-time
 *     concern. With index-time synonyms, every rule change means reindexing
 *     the whole catalogue.
 */
export function buildIndexSettings({ replicas = 0 } = {}) {
  return {
    settings: {
      number_of_shards: 1,
      number_of_replicas: replicas,
      analysis: {
        analyzer: {
          // What documents are stored as.
          product_index_analyzer: {
            type: "custom",
            tokenizer: "standard",
            filter: ["lowercase", "asciifolding"],
          },
          // What queries are parsed with: the same chain plus synonym
          // expansion, so the two stay symmetrical for every non-synonym term.
          product_search_analyzer: {
            type: "custom",
            tokenizer: "standard",
            filter: ["lowercase", "asciifolding", "product_synonyms"],
          },
        },
        filter: {
          product_synonyms: {
            type: "synonym_graph",
            synonyms: [
              "tee, t-shirt, tshirt",
              "sneaker, trainer, shoe",
              "laptop, notebook",
              "headphone, headset, earphone",
              "mug, cup",
              "bottle, flask",
            ],
          },
        },
        normalizer: {
          // Lets an exact-term filter on brand/category ignore case, so a facet
          // link built from "Northwind" still matches a client sending
          // "northwind".
          lowercase_normalizer: {
            type: "custom",
            filter: ["lowercase", "asciifolding"],
          },
        },
      },
    },
    mappings: {
      _meta: { mappingVersion: MAPPING_VERSION },
      dynamic: "strict",
      properties: {
        productId: { type: "keyword" },
        sku: { type: "keyword" },
        name: {
          type: "text",
          analyzer: "product_index_analyzer",
          search_analyzer: "product_search_analyzer",
          fields: {
            keyword: { type: "keyword", ignore_above: 256 },
            suggest: { type: "search_as_you_type" },
          },
        },
        description: {
          type: "text",
          analyzer: "product_index_analyzer",
          search_analyzer: "product_search_analyzer",
        },
        // brand and category stay `keyword`, because filtering and faceting
        // need the exact value. The `text` subfield is what makes them
        // searchable: a `match` against a bare keyword compares the whole query
        // string to the whole field value, so searching "northwind" could never
        // match a brand stored as "Northwind" — not even by case.
        category: keywordWithText(),
        brand: keywordWithText(),
        priceCents: { type: "integer" },
        currency: { type: "keyword" },
        imageUrl: { type: "keyword", index: false },
        isActive: { type: "boolean" },
        ratingAvg: { type: "half_float" },
        ratingCount: { type: "integer" },
        inStock: { type: "boolean" },
        attributes: {
          type: "object",
          // Facet values vary by product type; store them as a flattened field
          // so a new attribute never requires a mapping migration.
          enabled: true,
          dynamic: true,
        },
        createdAt: { type: "date" },
        updatedAt: { type: "date" },
      },
    },
  };
}

function keywordWithText() {
  return {
    type: "keyword",
    fields: {
      text: {
        type: "text",
        analyzer: "product_index_analyzer",
        search_analyzer: "product_search_analyzer",
      },
      folded: { type: "keyword", normalizer: "lowercase_normalizer" },
    },
  };
}
