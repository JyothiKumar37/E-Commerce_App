import { Client } from "@elastic/elasticsearch";
import { config } from "../config.js";
import { logger } from "./logger.js";
import { MAPPING_VERSION, buildIndexSettings } from "./mapping.js";

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
 * Reads and writes go through an alias, never a concrete index.
 *
 * An index's analyzers are fixed at creation: you cannot add a synonym rule or
 * change a tokenizer in place. The only way to alter them is to build a new
 * index and move the traffic, and an alias is what makes that swap atomic and
 * invisible to callers.
 */
export const INDEX = config.ELASTICSEARCH_INDEX;

export { MAPPING_VERSION };

const physicalIndexName = (version) => `${INDEX}-v${version}`;

const INDEX_SETTINGS = buildIndexSettings({ replicas: config.ELASTICSEARCH_REPLICAS });

/** The concrete index the alias currently points at, or null if unaliased. */
async function resolveAliasTarget() {
  try {
    const aliases = await elasticClient.indices.getAlias({ name: INDEX });
    const names = Object.keys(aliases);
    return names.length ? names[0] : null;
  } catch (err) {
    if (err?.meta?.statusCode === 404) return null;
    throw err;
  }
}

async function mappingVersionOf(index) {
  try {
    const response = await elasticClient.indices.getMapping({ index });
    return response[index]?.mappings?._meta?.mappingVersion ?? null;
  } catch {
    return null;
  }
}

/**
 * Brings the cluster in line with INDEX_SETTINGS, rebuilding when the live
 * mapping is out of date. Called once at boot.
 *
 * `reindex(target)` is injected rather than imported so this module keeps no
 * knowledge of Postgres; the caller supplies the document source.
 *
 * The old index keeps serving traffic for the whole rebuild — the alias only
 * moves once the new one is fully populated — so a mapping change costs
 * staleness, not downtime.
 *
 * This is also a plain async function, deliberately *not* wrapped in
 * `asyncHandler`. The original `setupElasticsearch` was an Express handler
 * invoked at startup as `(undefined, undefined, undefined)`; on the success
 * path it called `res.status(200)` on an undefined `res`, and the resulting
 * TypeError escaped as an unhandled rejection that killed the process on first
 * boot.
 */
export async function ensureIndex({ reindex } = {}) {
  const live = await resolveAliasTarget();

  if (live) {
    const version = await mappingVersionOf(live);
    if (version === MAPPING_VERSION) {
      logger.info({ index: live, mappingVersion: version }, "search index is current");
      return { rebuilt: false, index: live };
    }
    logger.warn(
      { index: live, found: version, expected: MAPPING_VERSION },
      "search index mapping is out of date; rebuilding",
    );
  }

  const target = physicalIndexName(MAPPING_VERSION);

  try {
    await elasticClient.indices.create({ index: target, ...INDEX_SETTINGS });
    logger.info({ index: target }, "created search index");
  } catch (err) {
    if (err?.meta?.body?.error?.type === "resource_already_exists_exception") {
      // Another replica got there first and is mid-reindex. Returning here
      // rather than falling through to the swap is the whole point: the index
      // exists but is only partly populated, so pointing the alias at it now
      // would publish an incomplete catalogue. Whoever created it performs the
      // swap when its reindex finishes.
      logger.info({ index: target }, "another replica is building this index; leaving the alias");
      return { rebuilt: false, index: live };
    }
    throw err;
  }

  if (typeof reindex === "function") {
    // Populate before the swap, so the alias never points at an empty index.
    // A failure here must not swap either — leaving the old index serving
    // stale results beats swapping onto an empty one.
    try {
      await reindex(target);
    } catch (err) {
      // Drop the half-filled index on the way out. Leaving it behind would be
      // worse than the original failure: the next boot would find it already
      // present, conclude another replica owns the rebuild, and skip straight
      // past — so a single transient error would strand the cluster on the old
      // mapping for good, with nothing but a log line to say why.
      logger.error(
        { index: target, err: { message: err.message } },
        "reindex failed; discarding the partial index so the next boot retries",
      );
      await elasticClient.indices.delete({ index: target }).catch(() => {});
      throw err;
    }
  }

  await swapAlias(target, live);
  return { rebuilt: true, index: target };
}

/**
 * Points the alias at `target` in a single atomic action, then cleans up.
 *
 * Doing the remove and the add in one `updateAliases` call matters: two
 * separate calls leave a window in which the alias resolves to nothing and
 * every query 404s.
 */
async function swapAlias(target, previous) {
  const actions = [{ add: { index: target, alias: INDEX } }];
  if (previous && previous !== target) {
    actions.unshift({ remove: { index: previous, alias: INDEX } });
  }

  // A cluster that ran an earlier build has a *concrete index* called
  // `products`, not an alias, and Elasticsearch refuses an alias whose name
  // collides with an existing index. Postgres is the source of truth and the
  // new index is already populated, so dropping it is safe.
  const collision = await elasticClient.indices.exists({ index: INDEX });
  if (collision && !previous) {
    logger.warn({ index: INDEX }, "removing legacy concrete index to free the alias name");
    await elasticClient.indices.delete({ index: INDEX });
  }

  await elasticClient.indices.updateAliases({ actions });
  logger.info({ alias: INDEX, index: target }, "search alias now points at the rebuilt index");

  if (previous && previous !== target) {
    try {
      await elasticClient.indices.delete({ index: previous });
      logger.info({ index: previous }, "removed superseded search index");
    } catch (err) {
      // Leaving it costs disk, not correctness.
      logger.warn({ index: previous, err: { message: err.message } }, "could not remove old index");
    }
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
