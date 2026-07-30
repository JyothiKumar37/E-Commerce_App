import { AppError, ErrorCodes, asyncHandler, paginated, withTransaction } from "@ecom/shared";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { pool } from "../lib/db.js";

const toPublicReview = (row) => ({
  reviewId: row.review_id,
  productId: row.product_id,
  rating: row.rating,
  title: row.title,
  body: row.body,
  isVerifiedPurchase: row.is_verified_purchase,
  helpfulCount: row.helpful_count,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  author: {
    // Never expose the reviewer's email or user id publicly.
    username: row.username,
    displayName: row.first_name
      ? `${row.first_name} ${(row.last_name ?? "").charAt(0)}.`
      : row.username,
  },
  isMine: row.is_mine ?? false,
});

/** Reviews for one product, with the rating histogram the UI renders. */
export const listForProduct = asyncHandler(async (req, res) => {
  const { productId } = req.params;
  const { page, pageSize, sort, rating } = req.query;
  const viewerId = req.auth?.userId ?? null;

  const params = [productId];
  let where = "r.product_id = $1 AND r.status = 'published'";
  if (rating) {
    params.push(rating);
    where += ` AND r.rating = $${params.length}`;
  }

  const orderBy = {
    newest: "r.created_at DESC",
    oldest: "r.created_at ASC",
    highest: "r.rating DESC, r.created_at DESC",
    lowest: "r.rating ASC, r.created_at DESC",
    helpful: "r.helpful_count DESC, r.created_at DESC",
  }[sort];

  const [{ rows: countRows }, { rows: histogramRows }] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS total FROM reviews r WHERE ${where}`, params),
    pool.query(
      `SELECT rating, COUNT(*)::int AS count
       FROM reviews WHERE product_id = $1 AND status = 'published'
       GROUP BY rating`,
      [productId],
    ),
  ]);

  const queryParams = [...params, viewerId, pageSize, (page - 1) * pageSize];
  const { rows } = await pool.query(
    `SELECT r.*, u.username, u.first_name, u.last_name,
            (r.user_id = $${params.length + 1}::uuid) AS is_mine
     FROM reviews r JOIN users u ON u.user_id = r.user_id
     WHERE ${where}
     ORDER BY ${orderBy}
     LIMIT $${params.length + 2} OFFSET $${params.length + 3}`,
    queryParams,
  );

  const histogram = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const row of histogramRows) histogram[row.rating] = row.count;
  const totalRatings = Object.values(histogram).reduce((a, b) => a + b, 0);
  const average =
    totalRatings === 0
      ? 0
      : Object.entries(histogram).reduce((sum, [star, count]) => sum + Number(star) * count, 0) /
        totalRatings;

  res.json({
    ...paginated(rows.map(toPublicReview), { page, pageSize, total: countRows[0].total }),
    summary: {
      average: Math.round(average * 100) / 100,
      total: totalRatings,
      histogram,
    },
  });
});

/** The signed-in user's own reviews, for the account area. */
export const listMine = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT r.*, u.username, u.first_name, u.last_name, TRUE AS is_mine, p.name AS product_name
     FROM reviews r
     JOIN users u ON u.user_id = r.user_id
     JOIN products p ON p.product_id = r.product_id
     WHERE r.user_id = $1
     ORDER BY r.created_at DESC LIMIT 100`,
    [req.auth.userId],
  );
  res.json({
    reviews: rows.map((row) => ({ ...toPublicReview(row), productName: row.product_name })),
  });
});

export const createReview = asyncHandler(async (req, res) => {
  const userId = req.auth.userId;
  const { productId, rating, title, body } = req.body;

  const review = await withTransaction(pool, async (client) => {
    const { rows: product } = await client.query(
      "SELECT product_id FROM products WHERE product_id = $1 AND is_active",
      [productId],
    );
    if (!product[0]) {
      throw new AppError({
        message: "Product not found.",
        statusCode: 404,
        errorCode: ErrorCodes.PRODUCT_NOT_FOUND,
      });
    }

    // A review is "verified" when the reviewer has a delivered order containing
    // the product. That badge is derived, never client-supplied.
    const { rows: purchase } = await client.query(
      `SELECT o.order_id FROM orders o
       JOIN order_items oi ON oi.order_id = o.order_id
       WHERE o.user_id = $1 AND oi.product_id = $2
         AND o.status IN ('delivered', 'shipped', 'processing', 'paid')
       ORDER BY o.placed_at DESC LIMIT 1`,
      [userId, productId],
    );
    const isVerified = purchase.length > 0;

    if (config.REQUIRE_VERIFIED_PURCHASE && !isVerified) {
      throw new AppError({
        message: "Only customers who have purchased this product can review it.",
        statusCode: 403,
        errorCode: ErrorCodes.NOT_PURCHASED,
      });
    }

    try {
      const { rows } = await client.query(
        `INSERT INTO reviews (product_id, user_id, order_id, rating, title, body, is_verified_purchase)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [productId, userId, purchase[0]?.order_id ?? null, rating, title, body, isVerified],
      );

      // The `reviews_rollup` trigger has already refreshed products.rating_avg;
      // re-index so search reflects the new score.
      await client.query(
        "INSERT INTO catalog_outbox (product_id, operation) VALUES ($1, 'upsert')",
        [productId],
      );

      return rows[0];
    } catch (err) {
      if (err.code === "23505") {
        throw new AppError({
          message: "You have already reviewed this product. Edit your existing review instead.",
          statusCode: 409,
          errorCode: ErrorCodes.DUPLICATE_REVIEW,
        });
      }
      throw err;
    }
  });

  const { rows: withAuthor } = await pool.query(
    `SELECT r.*, u.username, u.first_name, u.last_name, TRUE AS is_mine
     FROM reviews r JOIN users u ON u.user_id = r.user_id WHERE r.review_id = $1`,
    [review.review_id],
  );

  logger.info({ reviewId: review.review_id, productId, userId }, "review created");
  res
    .status(201)
    .json({ review: toPublicReview(withAuthor[0]), message: "Thanks for your review." });
});

export const updateReview = asyncHandler(async (req, res) => {
  const { reviewId } = req.params;
  const userId = req.auth.userId;

  const review = await withTransaction(pool, async (client) => {
    const { rows: existing } = await client.query(
      "SELECT * FROM reviews WHERE review_id = $1 FOR UPDATE",
      [reviewId],
    );
    if (!existing[0]) throw reviewNotFound();

    // Ownership check, not just existence: otherwise any authenticated user
    // could rewrite anyone's review.
    if (existing[0].user_id !== userId && req.auth.role !== "admin") {
      throw new AppError({
        message: "You can only edit your own reviews.",
        statusCode: 403,
        errorCode: ErrorCodes.FORBIDDEN,
      });
    }

    const { rows } = await client.query(
      `UPDATE reviews
       SET rating = COALESCE($2, rating),
           title  = COALESCE($3, title),
           body   = COALESCE($4, body)
       WHERE review_id = $1
       RETURNING *`,
      [reviewId, req.body.rating ?? null, req.body.title ?? null, req.body.body ?? null],
    );

    await client.query("INSERT INTO catalog_outbox (product_id, operation) VALUES ($1, 'upsert')", [
      existing[0].product_id,
    ]);

    return rows[0];
  });

  const { rows: withAuthor } = await pool.query(
    `SELECT r.*, u.username, u.first_name, u.last_name, TRUE AS is_mine
     FROM reviews r JOIN users u ON u.user_id = r.user_id WHERE r.review_id = $1`,
    [review.review_id],
  );

  res.json({ review: toPublicReview(withAuthor[0]), message: "Review updated." });
});

export const deleteReview = asyncHandler(async (req, res) => {
  const { reviewId } = req.params;

  await withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      "SELECT user_id, product_id FROM reviews WHERE review_id = $1 FOR UPDATE",
      [reviewId],
    );
    if (!rows[0]) throw reviewNotFound();

    if (rows[0].user_id !== req.auth.userId && req.auth.role !== "admin") {
      throw new AppError({
        message: "You can only delete your own reviews.",
        statusCode: 403,
        errorCode: ErrorCodes.FORBIDDEN,
      });
    }

    await client.query("DELETE FROM reviews WHERE review_id = $1", [reviewId]);
    await client.query("INSERT INTO catalog_outbox (product_id, operation) VALUES ($1, 'upsert')", [
      rows[0].product_id,
    ]);
  });

  res.json({ message: "Review deleted." });
});

/** "Was this helpful?" — one vote per user, tracked in Postgres via upsert. */
export const markHelpful = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE reviews SET helpful_count = helpful_count + 1
     WHERE review_id = $1 AND user_id <> $2
     RETURNING helpful_count`,
    [req.params.reviewId, req.auth.userId],
  );
  if (!rows[0]) {
    throw new AppError({
      message: "Review not found, or you cannot mark your own review helpful.",
      statusCode: 404,
      errorCode: ErrorCodes.REVIEW_NOT_FOUND,
    });
  }
  res.json({ helpfulCount: rows[0].helpful_count });
});

export const moderateReview = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE reviews SET status = $2 WHERE review_id = $1 RETURNING review_id, status, product_id`,
    [req.params.reviewId, req.body.status],
  );
  if (!rows[0]) throw reviewNotFound();

  await pool.query("INSERT INTO catalog_outbox (product_id, operation) VALUES ($1, 'upsert')", [
    rows[0].product_id,
  ]);

  logger.info({ reviewId: rows[0].review_id, status: rows[0].status }, "review moderated");
  res.json({ review: { reviewId: rows[0].review_id, status: rows[0].status } });
});

const reviewNotFound = () =>
  new AppError({
    message: "Review not found.",
    statusCode: 404,
    errorCode: ErrorCodes.REVIEW_NOT_FOUND,
  });
