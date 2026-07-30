import { AppError, ErrorCodes, asyncHandler, withTransaction } from "@ecom/shared";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { pool } from "../lib/db.js";
import { authorizeAndCapture, refund } from "../services/provider.js";

const toPublicPayment = (row) => ({
  paymentId: row.payment_id,
  orderId: row.order_id,
  method: row.method,
  cardLast4: row.card_last4,
  cardBrand: row.card_brand,
  amountCents: row.amount_cents,
  currency: row.currency,
  status: row.status,
  failureReason: row.failure_reason,
  providerRef: row.provider_ref,
  createdAt: row.created_at,
});

/**
 * Charge an order.
 *
 * Idempotent on `Idempotency-Key`: the unique index on
 * `payments.idempotency_key` is the authority, so even a Redis flush or a race
 * between two replicas cannot produce a double charge.
 */
export const charge = asyncHandler(async (req, res) => {
  const userId = req.auth.userId;
  const idempotencyKey = req.headers["idempotency-key"];

  if (!idempotencyKey) {
    throw new AppError({
      message: "An Idempotency-Key header is required to charge a payment.",
      statusCode: 400,
      errorCode: "IDEMPOTENCY_KEY_REQUIRED",
    });
  }

  const { orderId, amountCents, currency, method, paymentToken, cardLast4, cardBrand } = req.body;

  // Replay: return the original outcome verbatim.
  const { rows: existing } = await pool.query("SELECT * FROM payments WHERE idempotency_key = $1", [
    idempotencyKey,
  ]);
  if (existing[0]) {
    if (existing[0].user_id !== userId || existing[0].order_id !== orderId) {
      throw new AppError({
        message: "This Idempotency-Key was already used for a different payment.",
        statusCode: 409,
        errorCode: ErrorCodes.IDEMPOTENCY_CONFLICT,
      });
    }
    return res.status(200).json({
      payment: toPublicPayment(existing[0]),
      replayed: true,
    });
  }

  // Verify the order is chargeable and that the amount matches, so a tampered
  // client cannot pay 1 cent for a 400 euro order.
  const { rows: orderRows } = await pool.query(
    "SELECT order_id, user_id, status, total_cents, currency FROM orders WHERE order_id = $1",
    [orderId],
  );
  const order = orderRows[0];

  if (!order || order.user_id !== userId) {
    throw new AppError({
      message: "Order not found.",
      statusCode: 404,
      errorCode: ErrorCodes.ORDER_NOT_FOUND,
    });
  }
  if (order.status !== "pending_payment") {
    throw new AppError({
      message: `This order is ${order.status} and cannot be paid again.`,
      statusCode: 409,
      errorCode: "ORDER_NOT_PAYABLE",
    });
  }
  if (order.total_cents !== amountCents || order.currency !== currency) {
    throw new AppError({
      message: "Payment amount does not match the order total.",
      statusCode: 409,
      errorCode: ErrorCodes.PRICE_CHANGED,
      details: { expectedCents: order.total_cents, receivedCents: amountCents },
    });
  }

  // Record the attempt before calling the provider. If this process dies
  // mid-call, the row proves an attempt was made and the key is burned.
  let paymentId;
  try {
    const { rows } = await pool.query(
      `INSERT INTO payments (order_id, user_id, provider, method, card_last4, card_brand,
                             amount_cents, currency, status, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)
       RETURNING payment_id`,
      [
        orderId,
        userId,
        config.PAYMENT_PROVIDER,
        method,
        cardLast4 ?? null,
        cardBrand ?? null,
        amountCents,
        currency,
        idempotencyKey,
      ],
    );
    paymentId = rows[0].payment_id;
  } catch (err) {
    if (err.code === "23505") {
      throw new AppError({
        message: "A payment with this Idempotency-Key is already being processed.",
        statusCode: 409,
        errorCode: ErrorCodes.IDEMPOTENCY_CONFLICT,
      });
    }
    throw err;
  }

  const result = await authorizeAndCapture({ amountCents, currency, method, paymentToken });

  const payment = await withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `UPDATE payments
       SET status = $2, provider_ref = $3, failure_reason = $4
       WHERE payment_id = $1
       RETURNING *`,
      [paymentId, result.status, result.providerRef, result.failureReason ?? null],
    );

    if (result.status === "captured") {
      await client.query(
        "UPDATE orders SET status = 'paid' WHERE order_id = $1 AND status = 'pending_payment'",
        [orderId],
      );
      await client.query(
        `INSERT INTO order_events (order_id, status, note, actor)
         VALUES ($1, 'paid', $2, 'payment-service')`,
        [orderId, `Payment captured (${method})`],
      );
    } else {
      await client.query(
        `INSERT INTO order_events (order_id, status, note, actor)
         VALUES ($1, 'payment_failed', $2, 'payment-service')`,
        [orderId, `Payment declined: ${result.failureReason}`],
      );
    }

    return rows[0];
  });

  logger.info({ paymentId, orderId, status: result.status, userId }, "payment processed");

  if (result.status !== "captured") {
    throw new AppError({
      message: declineMessage(result.failureReason),
      statusCode: 402,
      errorCode: ErrorCodes.PAYMENT_DECLINED,
      details: { paymentId, reason: result.failureReason },
    });
  }

  return res.status(201).json({ payment: toPublicPayment(payment), replayed: false });
});

export const listPayments = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [req.auth.userId],
  );
  res.json({ payments: rows.map(toPublicPayment) });
});

export const getPayment = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM payments WHERE payment_id = $1 AND user_id = $2",
    [req.params.paymentId, req.auth.userId],
  );
  if (!rows[0]) {
    throw new AppError({
      message: "Payment not found.",
      statusCode: 404,
      errorCode: ErrorCodes.PAYMENT_NOT_FOUND,
    });
  }
  res.json({ payment: toPublicPayment(rows[0]) });
});

export const refundPayment = asyncHandler(async (req, res) => {
  const { paymentId } = req.params;

  const payment = await withTransaction(pool, async (client) => {
    const { rows } = await client.query("SELECT * FROM payments WHERE payment_id = $1 FOR UPDATE", [
      paymentId,
    ]);
    const existing = rows[0];

    if (!existing) {
      throw new AppError({
        message: "Payment not found.",
        statusCode: 404,
        errorCode: ErrorCodes.PAYMENT_NOT_FOUND,
      });
    }
    if (existing.status === "refunded") return existing; // idempotent
    if (existing.status !== "captured") {
      throw new AppError({
        message: `Only captured payments can be refunded; this one is ${existing.status}.`,
        statusCode: 409,
        errorCode: "PAYMENT_NOT_REFUNDABLE",
      });
    }

    await refund({ providerRef: existing.provider_ref, amountCents: existing.amount_cents });

    const { rows: updated } = await client.query(
      "UPDATE payments SET status = 'refunded' WHERE payment_id = $1 RETURNING *",
      [paymentId],
    );
    await client.query("UPDATE orders SET status = 'refunded' WHERE order_id = $1", [
      existing.order_id,
    ]);
    await client.query(
      `INSERT INTO order_events (order_id, status, note, actor)
       VALUES ($1, 'refunded', 'Payment refunded', 'payment-service')`,
      [existing.order_id],
    );

    return updated[0];
  });

  logger.info({ paymentId }, "payment refunded");
  res.json({ payment: toPublicPayment(payment), message: "Payment refunded." });
});

function declineMessage(reason) {
  const messages = {
    insufficient_funds: "Your card was declined due to insufficient funds.",
    card_expired: "Your card has expired. Please use a different payment method.",
    do_not_honour: "Your card was declined. Please contact your bank or try another card.",
    suspected_fraud: "This payment was blocked by your bank's fraud checks.",
  };
  return messages[reason] ?? "Your payment was declined. Please try another payment method.";
}
