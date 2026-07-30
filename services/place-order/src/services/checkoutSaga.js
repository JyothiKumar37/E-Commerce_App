import { randomUUID } from "node:crypto";
import { AppError, ErrorCodes, calculateTotals, withTransaction } from "@ecom/shared";
import { config } from "../config.js";
import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import {
  accountClient,
  cartClient,
  inventoryClient,
  paymentClient,
  shippingClient,
} from "../lib/clients.js";

/**
 * Checkout saga.
 *
 * Steps, with the compensating action for each:
 *
 *   1. load cart + address       (no side effect)
 *   2. reserve inventory         -> release reservation
 *   3. create order (pending)    -> mark order failed
 *   4. capture payment           -> refund is manual; order marked failed
 *   5. commit reservation        -> (past the point of no return)
 *   6. create shipment           -> logged, retried out of band
 *   7. clear cart                -> best effort
 *
 * Steps 1-4 are all reversible. Step 5 onward is not, so ordering matters:
 * money is only taken once stock is definitely held, and stock is only
 * permanently consumed once money is definitely captured.
 */
export async function placeOrder({ userId, auth, payload, idempotencyKey }) {
  const startedAt = Date.now();
  let reservationId = null;
  let orderId = null;

  try {
    // --- 1. gather inputs -------------------------------------------
    const [{ cart }, { address }] = await Promise.all([
      cartClient.get("/", { auth }),
      accountClient.get(`/internal/addresses/${payload.shippingAddressId}`, { auth }),
    ]);

    if (!cart.items || cart.items.length === 0) {
      throw new AppError({
        message: "Your cart is empty.",
        statusCode: 400,
        errorCode: ErrorCodes.CART_EMPTY,
      });
    }
    if (cart.unavailable?.length > 0) {
      throw new AppError({
        message: "Some items in your cart are no longer available. Please review your cart.",
        statusCode: 409,
        errorCode: ErrorCodes.INSUFFICIENT_STOCK,
        details: { unavailable: cart.unavailable },
      });
    }

    // Re-price server-side from the cart's live catalog data. The client's
    // idea of the total is never trusted.
    const totals = calculateTotals(cart.items, {
      taxRate: config.TAX_RATE,
      freeThresholdCents: config.FREE_SHIPPING_THRESHOLD_CENTS,
      flatRateCents: config.FLAT_SHIPPING_CENTS,
    });

    // If the client showed the customer a different total, stop and make them
    // re-confirm rather than silently charging a different amount.
    if (payload.expectedTotalCents != null && payload.expectedTotalCents !== totals.totalCents) {
      throw new AppError({
        message: "Prices in your cart have changed. Please review your order and try again.",
        statusCode: 409,
        errorCode: ErrorCodes.PRICE_CHANGED,
        details: { expectedCents: payload.expectedTotalCents, actualCents: totals.totalCents },
      });
    }

    // --- 2. reserve stock -------------------------------------------
    const { reservation } = await inventoryClient.post("/reservations", {
      auth,
      body: {
        items: cart.items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
      },
    });
    reservationId = reservation.reservationId;

    // --- 3. create the order in pending_payment ----------------------
    const order = await withTransaction(pool, async (client) => {
      const orderNumber = generateOrderNumber();

      const { rows } = await client.query(
        `INSERT INTO orders (order_number, user_id, status, subtotal_cents, shipping_cents,
                             tax_cents, total_cents, currency, shipping_address,
                             billing_address, reservation_id, idempotency_key)
         VALUES ($1, $2, 'pending_payment', $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          orderNumber,
          userId,
          totals.subtotalCents,
          totals.shippingCents,
          totals.taxCents,
          totals.totalCents,
          cart.currency ?? "EUR",
          JSON.stringify(address),
          JSON.stringify(payload.billingAddress ?? address),
          reservationId,
          idempotencyKey,
        ],
      );
      const created = rows[0];

      for (const item of cart.items) {
        await client.query(
          `INSERT INTO order_items (order_id, product_id, sku, name, image_url,
                                    unit_price_cents, quantity, total_cents)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            created.order_id,
            item.productId,
            item.sku,
            item.name,
            item.imageUrl ?? null,
            item.unitPriceCents,
            item.quantity,
            item.unitPriceCents * item.quantity,
          ],
        );
      }

      await client.query(
        `INSERT INTO order_events (order_id, status, note, actor)
         VALUES ($1, 'pending_payment', 'Order created', 'place-order')`,
        [created.order_id],
      );

      return created;
    });
    orderId = order.order_id;

    // --- 4. capture payment ------------------------------------------
    // Deliberately before the reservation is committed: stock stays merely
    // *held* until the money is captured, so a decline leaves nothing to undo
    // beyond releasing the hold.
    let payment;
    try {
      const response = await paymentClient.post("/charges", {
        auth,
        // Derived from the checkout key so a retried checkout reuses the same
        // payment key and cannot double charge.
        idempotencyKey: `${idempotencyKey}:payment`,
        body: {
          orderId,
          amountCents: totals.totalCents,
          currency: order.currency,
          method: payload.paymentMethod,
          paymentToken: payload.paymentToken,
          cardLast4: payload.cardLast4 ?? null,
          cardBrand: payload.cardBrand ?? null,
        },
      });
      payment = response.payment;
    } catch (err) {
      await markOrderFailed(orderId, err.message);
      await releaseReservation(reservationId, auth);
      reservationId = null;
      throw err;
    }

    // --- 5. commit the reservation (point of no return) ---------------
    try {
      await inventoryClient.post(`/reservations/${reservationId}/commit`, {
        auth,
        body: { orderId },
      });
    } catch (err) {
      // Money is captured and the order is real. Do not fail the customer's
      // checkout over a bookkeeping call — flag it for reconciliation instead.
      logger.error(
        { err: { message: err.message }, orderId, reservationId },
        "reservation commit failed after payment capture; requires reconciliation",
      );
      await recordEvent(
        orderId,
        "reconciliation_required",
        `Reservation commit failed: ${err.message}`,
      );
    }
    reservationId = null;

    await withTransaction(pool, async (client) => {
      await client.query("UPDATE orders SET status = 'processing' WHERE order_id = $1", [orderId]);
      await client.query(
        `INSERT INTO order_events (order_id, status, note, actor)
         VALUES ($1, 'processing', 'Payment confirmed, preparing shipment', 'place-order')`,
        [orderId],
      );
    });

    // --- 6 & 7. shipment and cart cleanup -----------------------------
    // Neither is allowed to fail the order; both are retryable out of band.
    const [shipmentResult] = await Promise.allSettled([
      shippingClient.post("/shipments", {
        auth,
        body: {
          orderId,
          destination: address,
          serviceLevel: payload.shippingMethod ?? "standard",
        },
      }),
      cartClient.post("/internal/clear", { auth }),
    ]);

    if (shipmentResult.status === "rejected") {
      logger.error(
        { orderId, err: { message: shipmentResult.reason?.message } },
        "shipment creation failed; order stands and will be retried",
      );
      await recordEvent(orderId, "shipment_pending", "Shipment creation deferred");
    }

    logger.info(
      { orderId, userId, totalCents: totals.totalCents, durationMs: Date.now() - startedAt },
      "order placed",
    );

    return {
      orderId,
      orderNumber: order.order_number,
      status: "processing",
      totals,
      currency: order.currency,
      payment: { paymentId: payment.paymentId, status: payment.status },
      shipment: shipmentResult.status === "fulfilled" ? shipmentResult.value.shipment : null,
      items: cart.items.map((i) => ({
        productId: i.productId,
        name: i.name,
        quantity: i.quantity,
        unitPriceCents: i.unitPriceCents,
      })),
      placedAt: order.placed_at,
    };
  } catch (err) {
    // Any reservation still held at this point belongs to a checkout that
    // never completed; give the stock back immediately rather than waiting
    // for the sweeper.
    if (reservationId) await releaseReservation(reservationId, auth);
    throw err;
  }
}

async function releaseReservation(reservationId, auth) {
  try {
    await inventoryClient.post(`/reservations/${reservationId}/release`, { auth });
    logger.info({ reservationId }, "reservation released after failed checkout");
  } catch (err) {
    // The inventory sweeper will expire it on its own; log and move on.
    logger.error(
      { err: { message: err.message }, reservationId },
      "compensating release failed; sweeper will reclaim the stock",
    );
  }
}

async function markOrderFailed(orderId, reason) {
  try {
    await withTransaction(pool, async (client) => {
      await client.query(
        "UPDATE orders SET status = 'failed' WHERE order_id = $1 AND status = 'pending_payment'",
        [orderId],
      );
      await client.query(
        `INSERT INTO order_events (order_id, status, note, actor)
         VALUES ($1, 'failed', $2, 'place-order')`,
        [orderId, reason?.slice(0, 500) ?? "Checkout failed"],
      );
    });
  } catch (err) {
    logger.error({ err: { message: err.message }, orderId }, "could not mark order failed");
  }
}

async function recordEvent(orderId, status, note) {
  try {
    await pool.query(
      `INSERT INTO order_events (order_id, status, note, actor)
       VALUES ($1, $2, $3, 'place-order')`,
      [orderId, status, note?.slice(0, 500)],
    );
  } catch (err) {
    logger.error({ err: { message: err.message }, orderId }, "could not record order event");
  }
}

/**
 * Human-readable and non-enumerable: customers quote these over the phone, and
 * a sequential counter would leak daily order volume.
 */
function generateOrderNumber() {
  const now = new Date();
  const datePart = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(
    now.getUTCDate(),
  ).padStart(2, "0")}`;
  const randomPart = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  return `ORD-${datePart}-${randomPart}`;
}

/** Read-only preview of what checkout would charge; drives the review step. */
export async function previewCheckout({ auth, shippingAddressId }) {
  const [{ cart }, addressResponse] = await Promise.all([
    cartClient.get("/", { auth }),
    shippingAddressId
      ? accountClient.get(`/internal/addresses/${shippingAddressId}`, { auth })
      : Promise.resolve({ address: null }),
  ]);

  if (!cart.items || cart.items.length === 0) {
    throw new AppError({
      message: "Your cart is empty.",
      statusCode: 400,
      errorCode: ErrorCodes.CART_EMPTY,
    });
  }

  const totals = calculateTotals(cart.items, {
    taxRate: config.TAX_RATE,
    freeThresholdCents: config.FREE_SHIPPING_THRESHOLD_CENTS,
    flatRateCents: config.FLAT_SHIPPING_CENTS,
  });

  return {
    items: cart.items,
    unavailable: cart.unavailable ?? [],
    totals,
    currency: cart.currency ?? "EUR",
    shippingAddress: addressResponse.address,
    taxRate: config.TAX_RATE,
    freeShippingThresholdCents: config.FREE_SHIPPING_THRESHOLD_CENTS,
  };
}
