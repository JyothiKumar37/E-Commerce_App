import { withTransaction } from "@ecom/shared";
import { config } from "../config.js";
import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";

/**
 * Offline recommendation batch.
 *
 * Two models, both computed in SQL so the data never leaves Postgres:
 *
 *  1. Item-to-item affinity — cosine-like co-occurrence over completed orders.
 *     score = co_occurrences / sqrt(count(A) * count(B)), which normalises away
 *     the popularity bias that raw co-occurrence counts suffer from (otherwise
 *     the best-selling item is "related" to everything).
 *
 *  2. Per-user recommendations — affinity from what the user has bought and
 *     viewed, minus anything they already own.
 */

let running = false;

export async function generate({ strategy = "co_occurrence_v1" } = {}) {
  if (running) {
    return { skipped: true, reason: "A generation run is already in progress." };
  }
  running = true;

  const { rows: runRows } = await pool.query(
    "INSERT INTO recommendation_runs (strategy) VALUES ($1) RETURNING run_id, started_at",
    [strategy],
  );
  const runId = runRows[0].run_id;
  const startedAt = Date.now();

  try {
    const pairsScored = await buildAffinity();
    const usersScored = await buildUserRecommendations();

    await pool.query(
      `UPDATE recommendation_runs
       SET status = 'completed', users_scored = $2, pairs_scored = $3, finished_at = NOW()
       WHERE run_id = $1`,
      [runId, usersScored, pairsScored],
    );

    const durationMs = Date.now() - startedAt;
    logger.info({ runId, usersScored, pairsScored, durationMs }, "recommendation run complete");
    return { runId, usersScored, pairsScored, durationMs, status: "completed" };
  } catch (err) {
    await pool.query(
      `UPDATE recommendation_runs
       SET status = 'failed', error = $2, finished_at = NOW()
       WHERE run_id = $1`,
      [runId, err.message.slice(0, 1000)],
    );
    logger.error({ runId, err: { message: err.message } }, "recommendation run failed");
    throw err;
  } finally {
    running = false;
  }
}

async function buildAffinity() {
  return withTransaction(pool, async (client) => {
    // Rebuild into a temp table, then swap. A DELETE-then-INSERT would leave
    // the serving layer reading an empty table mid-run.
    await client.query(
      `
      CREATE TEMP TABLE affinity_next ON COMMIT DROP AS
      WITH order_products AS (
        SELECT DISTINCT o.order_id, oi.product_id
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.order_id
        WHERE o.status IN ('paid', 'processing', 'shipped', 'delivered')
      ),
      product_totals AS (
        SELECT product_id, COUNT(DISTINCT order_id)::numeric AS order_count
        FROM order_products GROUP BY product_id
      ),
      pairs AS (
        SELECT a.product_id AS product_id,
               b.product_id AS related_id,
               COUNT(*)::numeric AS co_occurrences
        FROM order_products a
        JOIN order_products b
          ON a.order_id = b.order_id AND a.product_id <> b.product_id
        GROUP BY a.product_id, b.product_id
      )
      SELECT p.product_id,
             p.related_id,
             p.co_occurrences,
             -- Normalised so a blockbuster does not dominate every shelf.
             (p.co_occurrences / SQRT(ta.order_count * tb.order_count)) AS score
      FROM pairs p
      JOIN product_totals ta ON ta.product_id = p.product_id
      JOIN product_totals tb ON tb.product_id = p.related_id
      WHERE p.co_occurrences >= $1
    `,
      [config.MIN_CO_OCCURRENCES],
    );

    await client.query("DELETE FROM product_affinity");

    const { rowCount } = await client.query(
      `INSERT INTO product_affinity (product_id, related_id, score, co_occurrences)
       SELECT product_id, related_id, LEAST(score, 9.999999), co_occurrences::int
       FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY product_id ORDER BY score DESC) AS rank
         FROM affinity_next
       ) ranked
       WHERE rank <= $1`,
      [config.AFFINITY_PER_PRODUCT],
    );

    return rowCount;
  });
}

async function buildUserRecommendations() {
  return withTransaction(pool, async (client) => {
    await client.query(`
      CREATE TEMP TABLE recs_next ON COMMIT DROP AS
      WITH purchased AS (
        SELECT DISTINCT o.user_id, oi.product_id
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.order_id
        WHERE o.status IN ('paid', 'processing', 'shipped', 'delivered')
      ),
      viewed AS (
        SELECT user_id, product_id, COUNT(*)::numeric AS views
        FROM product_views
        WHERE user_id IS NOT NULL AND viewed_at > NOW() - INTERVAL '90 days'
        GROUP BY user_id, product_id
      ),
      -- Products related to what the user bought, weighted by affinity.
      from_purchases AS (
        SELECT p.user_id, pa.related_id AS product_id,
               SUM(pa.score)::numeric AS score, 'bought_related' AS reason
        FROM purchased p
        JOIN product_affinity pa ON pa.product_id = p.product_id
        GROUP BY p.user_id, pa.related_id
      ),
      -- Products related to what the user viewed, damped: a view is a much
      -- weaker signal of intent than a purchase.
      from_views AS (
        SELECT v.user_id, pa.related_id AS product_id,
               SUM(pa.score * LEAST(v.views, 5) * 0.3)::numeric AS score,
               'viewed_related' AS reason
        FROM viewed v
        JOIN product_affinity pa ON pa.product_id = v.product_id
        GROUP BY v.user_id, pa.related_id
      ),
      combined AS (
        SELECT * FROM from_purchases
        UNION ALL
        SELECT * FROM from_views
      ),
      aggregated AS (
        SELECT c.user_id, c.product_id,
               SUM(c.score) AS score,
               (ARRAY_AGG(c.reason ORDER BY c.score DESC))[1] AS reason
        FROM combined c
        GROUP BY c.user_id, c.product_id
      )
      SELECT a.user_id, a.product_id, a.score, a.reason
      FROM aggregated a
      JOIN products pr ON pr.product_id = a.product_id AND pr.is_active
      LEFT JOIN inventory i ON i.product_id = a.product_id
      -- Never recommend something the customer already bought, or that we
      -- cannot ship.
      WHERE NOT EXISTS (
              SELECT 1 FROM purchased p
              WHERE p.user_id = a.user_id AND p.product_id = a.product_id
            )
        AND COALESCE(i.available, 0) > 0
    `);

    await client.query("DELETE FROM user_recommendations");

    const { rowCount } = await client.query(
      `INSERT INTO user_recommendations (user_id, product_id, score, reason)
       SELECT user_id, product_id, LEAST(score, 99.999999), reason
       FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY score DESC) AS rank
         FROM recs_next
       ) ranked
       WHERE rank <= $1`,
      [config.RECOMMENDATIONS_PER_USER],
    );

    const { rows } = await client.query(
      "SELECT COUNT(DISTINCT user_id)::int AS users FROM user_recommendations",
    );
    logger.debug({ rows: rowCount, users: rows[0].users }, "user recommendations written");

    return rows[0].users;
  });
}

let timer = null;

export function startScheduler() {
  if (!config.RUN_ON_SCHEDULE) {
    logger.info("scheduled generation disabled; trigger runs via POST /runs");
    return;
  }

  if (config.RUN_ON_BOOT) {
    generate().catch((err) =>
      logger.error({ err: { message: err.message } }, "boot generation failed"),
    );
  }

  timer = setInterval(() => {
    generate().catch((err) =>
      logger.error({ err: { message: err.message } }, "scheduled generation failed"),
    );
  }, config.RUN_INTERVAL_MS);
  timer.unref();

  logger.info({ intervalMs: config.RUN_INTERVAL_MS }, "recommendation scheduler started");
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
