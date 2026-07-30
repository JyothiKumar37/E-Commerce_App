import { withTransaction } from "@ecom/shared";
import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { config } from "../config.js";
import { INDEX, elasticClient, toSearchDocument } from "../lib/elastic.js";

/**
 * Transactional-outbox worker.
 *
 * Catalog writes commit a row to `catalog_outbox` in the same transaction as
 * the product change, and this loop replays those rows into Elasticsearch.
 *
 * The original code wrote to DynamoDB and then called Elasticsearch inline. A
 * crash, timeout or ES outage between the two left the index permanently
 * inconsistent with the source of truth, with no way to notice or repair it.
 * With an outbox the write is durable first and the index catches up, so the
 * worst case is staleness measured in seconds rather than silent divergence.
 */

const MAX_ATTEMPTS = 5;

export async function drainOutbox({ batchSize = config.INDEXER_BATCH_SIZE } = {}) {
  return withTransaction(pool, async (client) => {
    // SKIP LOCKED lets several replicas drain the queue concurrently without
    // processing the same row twice.
    const { rows: pending } = await client.query(
      `SELECT outbox_id, product_id, operation, attempts
       FROM catalog_outbox
       WHERE processed_at IS NULL AND attempts < $2
       ORDER BY outbox_id
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [batchSize, MAX_ATTEMPTS],
    );

    if (pending.length === 0) return { processed: 0, failed: 0 };

    const upsertIds = pending.filter((r) => r.operation === "upsert").map((r) => r.product_id);
    const deleteIds = pending.filter((r) => r.operation === "delete").map((r) => r.product_id);

    const documents = upsertIds.length ? await loadDocuments(client, upsertIds) : [];
    const operations = [];

    for (const doc of documents) {
      operations.push({ index: { _index: INDEX, _id: doc.productId } }, doc);
    }
    for (const productId of deleteIds) {
      operations.push({ delete: { _index: INDEX, _id: productId } });
    }

    // A product enqueued for upsert but since hard-deleted has no row to load;
    // remove it from the index rather than leaving a ghost document.
    const loadedIds = new Set(documents.map((d) => d.productId));
    for (const productId of upsertIds.filter((id) => !loadedIds.has(id))) {
      operations.push({ delete: { _index: INDEX, _id: productId } });
    }

    if (operations.length === 0) {
      await markProcessed(
        client,
        pending.map((r) => r.outbox_id),
      );
      return { processed: pending.length, failed: 0 };
    }

    const response = await elasticClient.bulk({ refresh: false, operations });

    if (!response.errors) {
      await markProcessed(
        client,
        pending.map((r) => r.outbox_id),
      );
      return { processed: pending.length, failed: 0 };
    }

    // Partial failure: retire what succeeded, count an attempt against the rest
    // so a poison document cannot block the queue forever.
    const failedIds = new Set();
    for (const item of response.items) {
      const action = item.index ?? item.delete ?? item.create ?? item.update;
      // A delete for a document that was never indexed is not an error.
      if (action?.error && action.status !== 404) failedIds.add(action._id);
    }

    const succeeded = pending.filter((r) => !failedIds.has(r.product_id));
    const failed = pending.filter((r) => failedIds.has(r.product_id));

    if (succeeded.length)
      await markProcessed(
        client,
        succeeded.map((r) => r.outbox_id),
      );
    if (failed.length) {
      await client.query(
        `UPDATE catalog_outbox
         SET attempts = attempts + 1, last_error = $2
         WHERE outbox_id = ANY($1::bigint[])`,
        [failed.map((r) => r.outbox_id), "bulk indexing error"],
      );
      logger.warn({ count: failed.length }, "outbox entries failed to index");
    }

    return { processed: succeeded.length, failed: failed.length };
  });
}

async function loadDocuments(client, productIds) {
  const { rows } = await client.query(
    `SELECT p.*, COALESCE(i.available, 0) AS available
     FROM products p
     LEFT JOIN inventory i ON i.product_id = p.product_id
     WHERE p.product_id = ANY($1::uuid[])`,
    [productIds],
  );
  return rows.map(toSearchDocument);
}

function markProcessed(client, outboxIds) {
  return client.query(
    `UPDATE catalog_outbox SET processed_at = NOW() WHERE outbox_id = ANY($1::bigint[])`,
    [outboxIds],
  );
}

/** Full rebuild, used on first boot and exposed as an admin endpoint. */
export async function reindexAll({ batchSize = 500 } = {}) {
  let cursor = null;
  let total = 0;

  for (;;) {
    const { rows } = await pool.query(
      `SELECT p.*, COALESCE(i.available, 0) AS available
       FROM products p
       LEFT JOIN inventory i ON i.product_id = p.product_id
       WHERE ($1::uuid IS NULL OR p.product_id > $1)
       ORDER BY p.product_id
       LIMIT $2`,
      [cursor, batchSize],
    );

    if (rows.length === 0) break;

    const operations = rows.flatMap((row) => {
      const doc = toSearchDocument(row);
      return [{ index: { _index: INDEX, _id: doc.productId } }, doc];
    });

    const response = await elasticClient.bulk({ refresh: false, operations });
    if (response.errors) {
      const firstError = response.items.find((i) => i.index?.error)?.index?.error;
      throw new Error(`Reindex failed: ${firstError?.reason ?? "unknown bulk error"}`);
    }

    total += rows.length;
    cursor = rows[rows.length - 1].product_id;
  }

  await elasticClient.indices.refresh({ index: INDEX });
  logger.info({ total }, "reindex complete");
  return { indexed: total };
}

let timer = null;
let running = false;

export function startIndexer() {
  if (!config.INDEXER_ENABLED) {
    logger.info("outbox indexer disabled by configuration");
    return;
  }

  const tick = async () => {
    // Guard against overlapping runs when a batch takes longer than the tick.
    if (running) return;
    running = true;
    try {
      const result = await drainOutbox();
      if (result.processed > 0) logger.debug(result, "outbox drained");
    } catch (err) {
      logger.error({ err: { message: err.message } }, "outbox drain failed");
    } finally {
      running = false;
    }
  };

  timer = setInterval(tick, config.INDEXER_INTERVAL_MS);
  timer.unref(); // never hold the process open on its own
  logger.info({ intervalMs: config.INDEXER_INTERVAL_MS }, "outbox indexer started");
}

export function stopIndexer() {
  if (timer) clearInterval(timer);
  timer = null;
}
