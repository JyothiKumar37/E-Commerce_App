import { AppError, asyncHandler } from "@ecom/shared";
import { logger } from "../lib/logger.js";
import { pool } from "../lib/db.js";
import { generate } from "../services/generator.js";

/** Kicks off a batch. Returns 202 unless the caller asked to wait. */
export const startRun = asyncHandler(async (req, res) => {
  if (req.body.wait) {
    return res.json(await generate({ strategy: req.body.strategy }));
  }

  generate({ strategy: req.body.strategy }).catch((err) =>
    logger.error({ err: { message: err.message } }, "async generation failed"),
  );
  return res.status(202).json({ message: "Generation started." });
});

export const listRuns = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT run_id, status, strategy, users_scored, pairs_scored, error,
            started_at, finished_at
     FROM recommendation_runs ORDER BY started_at DESC LIMIT 50`,
  );

  res.json({
    runs: rows.map((r) => ({
      runId: r.run_id,
      status: r.status,
      strategy: r.strategy,
      usersScored: r.users_scored,
      pairsScored: r.pairs_scored,
      error: r.error,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      durationMs: r.finished_at ? new Date(r.finished_at) - new Date(r.started_at) : null,
    })),
  });
});

export const getRun = asyncHandler(async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM recommendation_runs WHERE run_id = $1", [
    req.params.runId,
  ]);
  if (!rows[0]) {
    throw new AppError({
      message: "Run not found.",
      statusCode: 404,
      errorCode: "RUN_NOT_FOUND",
    });
  }
  res.json({ run: rows[0] });
});

/** Coverage stats, so an operator can see whether the model is doing anything. */
export const getStats = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM product_affinity)                    AS affinity_pairs,
      (SELECT COUNT(DISTINCT user_id)::int FROM user_recommendations) AS users_with_recs,
      (SELECT COUNT(*)::int FROM user_recommendations)                AS total_recommendations,
      (SELECT COUNT(*)::int FROM users WHERE is_active)               AS active_users,
      (SELECT COUNT(*)::int FROM product_views
         WHERE viewed_at > NOW() - INTERVAL '7 days')                 AS views_last_7d
  `);

  const stats = rows[0];
  res.json({
    ...stats,
    coverage:
      stats.active_users > 0
        ? Math.round((stats.users_with_recs / stats.active_users) * 100) / 100
        : 0,
  });
});
