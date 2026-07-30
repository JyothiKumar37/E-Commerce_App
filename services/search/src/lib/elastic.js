import { Client } from "@elastic/elasticsearch";
import { config } from "../config.js";
import { logger } from "./logger.js";

/**
 * Elasticsearch client.
 *
 * The previous construction passed `auth: { ELASTIC_API_KEY, ELASTIC_USERNAME,
 * ELASTIC_PASSWORD }` — shorthand-property names the client does not recognise,
 * so authentication was silently never applied. It also set
 * `ssl: { rejectUnauthorized: false }` (wrong key name *and* wrong policy; the
 * v8 client expects `tls`). Both are fixed here, and the auth mode is chosen
 * explicitly.
 */
function buildAuth() {
  if (config.ELASTICSEARCH_API_KEY) {
    return { apiKey: config.ELASTICSEARCH_API_KEY };
  }
  if (config.ELASTICSEARCH_USERNAME && config.ELASTICSEARCH_PASSWORD) {
    return {
      username: config.ELASTICSEARCH_USERNAME,
      password: config.ELASTICSEARCH_PASSWORD,
    };
  }
  // Local single-node clusters with security disabled.
  return undefined;
}

export const INDEX = config.ELASTICSEARCH_INDEX;

export const elasticClient = new Client({
  node: config.ELASTICSEARCH_URL,
  auth: buildAuth(),
  requestTimeout: 5_000,
  maxRetries: 2,
  ...(config.ELASTICSEARCH_CA_CERT
    ? { tls: { ca: config.ELASTICSEARCH_CA_CERT, rejectUnauthorized: true } }
    : {}),
});

/**
 * Index mapping.
 *
 * The old mapping declared a single `ItemDescription` text field, so category,
 * brand and name were dynamically mapped and could not be filtered or sorted
 * reliably. Fields are explicit here: `text` for relevance, `keyword` for
 * faceting, and `search_as_you_type` on the name for the suggest endpoint.
 */
const INDEX_SETTINGS = {
  settings: {
    number_of_shards: 1,
    number_of_replicas: process.env.NODE_ENV === "production" ? 1 : 0,
    analysis: {
      analyzer: {
        product_analyzer: {
          type: "custom",
          tokenizer: "standard",
          filter: ["lowercase", "asciifolding", "product_synonyms"],
        },
      },
      filter: {
        product_synonyms: {
          type: "synonym",
          synonyms: ["tee, t-shirt, tshirt", "sneaker, trainer, shoe", "laptop, notebook"],
        },
      },
    },
  },
  mappings: {
    dynamic: "strict",
    properties: {
      productId: { type: "keyword" },
      sku: { type: "keyword" },
      name: {
        type: "text",
        analyzer: "product_analyzer",
        fields: {
          keyword: { type: "keyword", ignore_above: 256 },
          suggest: { type: "search_as_you_type" },
        },
      },
      description: { type: "text", analyzer: "product_analyzer" },
      category: { type: "keyword" },
      brand: { type: "keyword" },
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
        // so new attributes never require a mapping migration.
        enabled: true,
        dynamic: true,
      },
      createdAt: { type: "date" },
      updatedAt: { type: "date" },
    },
  },
};

/**
 * Creates the index if it is missing. Called once at boot.
 *
 * This is a plain async function, deliberately *not* wrapped in `asyncHandler`.
 * The old `setupElasticsearch` was an Express handler invoked at startup with
 * `(undefined, undefined, undefined)`; on the success path it then called
 * `res.status(200)` on an undefined `res`, and the resulting TypeError escaped
 * as an unhandled rejection that killed the process on first boot.
 */
export async function ensureIndex() {
  const exists = await elasticClient.indices.exists({ index: INDEX });
  if (exists) {
    logger.info({ index: INDEX }, "elasticsearch index already present");
    return false;
  }

  try {
    await elasticClient.indices.create({ index: INDEX, ...INDEX_SETTINGS });
    logger.info({ index: INDEX }, "elasticsearch index created");
    return true;
  } catch (err) {
    // Another replica won the race; that is success, not failure.
    if (err?.meta?.body?.error?.type === "resource_already_exists_exception") {
      logger.info({ index: INDEX }, "elasticsearch index created concurrently");
      return false;
    }
    throw err;
  }
}

export async function checkElastic() {
  const health = await elasticClient.cluster.health({ timeout: "2s" });
  if (health.status === "red") throw new Error("Elasticsearch cluster health is red");
  return true;
}

/** Maps a Postgres product row onto the index document shape. */
export function toSearchDocument(row) {
  return {
    productId: row.product_id,
    sku: row.sku,
    name: row.name,
    description: row.description,
    category: row.category,
    brand: row.brand,
    priceCents: row.price_cents,
    currency: row.currency,
    imageUrl: row.image_url,
    isActive: row.is_active,
    ratingAvg: Number(row.rating_avg ?? 0),
    ratingCount: row.rating_count ?? 0,
    inStock: (row.available ?? 0) > 0,
    attributes: row.attributes ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
