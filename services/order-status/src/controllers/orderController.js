import { AppError, ErrorCodes, asyncHandler, paginated, withTransaction } from "@ecom/shared";
import { config } from "../config.js";
import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { inventoryClient } from "../lib/clients.js";

/**
 * Which transitions are legal. Encoding this as data rather than scattering
 * `if (status === ...)` checks means an illegal transition is impossible to
 * express, not merely unlikely.
 */
const ALLOWED_TRANSITIONS = {
  pending_payment: ["paid", "cancelled", "failed"],
  paid: ["processing", "cancelled", "refunded"],
  processing: ["shipped", "cancelled", "refunded"],
  shipped: ["delivered", "refunded"],
  delivered: ["refunded"],
  cancelled: [],
  refunded: [],
  failed: [],
};

/** Statuses a customer may cancel from themselves. */
const CUSTOMER_CANCELLABLE = new Set(["pending_payment", "paid", "processing"]);

const toPublicOrder = (row, items = [], events = [], shipment = null) => ({
  orderId: row.order_id,
  orderNumber: row.order_number,
  status: row.status,
  subtotalCents: row.subtotal_cents,
  shippingCents: row.shipping_cents,
  taxCents: row.tax_cents,
  totalCents: row.total_cents,
  currency: row.currency,
  shippingAddress: row.shipping_address,
  billingAddress: row.billing_address,
  placedAt: row.placed_at,
  cancelledAt: row.cancelled_at,
  updatedAt: row.updated_at,
  items: items.map((i) => ({
    orderItemId: i.order_item_id,
    productId: i.product_id,
    sku: i.sku,
    name: i.name,
    imageUrl: i.image_url,
    unitPriceCents: i.unit_price_cents,
    quantity: i.quantity,
    totalCents: i.total_cents,
  })),
  timeline: events.map((e) => ({
    status: e.status,
    note: e.note,
    actor: e.actor,
    at: e.created_at,
  })),
  shipment,
});

export const listOrders = asyncHandler(async (req, res) => {
  const { page, pageSize, status } = req.query;
  const params = [req.auth.userId];
  let where = "o.user_id = $1";

  if (status) {
    params.push(status);
    where += ` AND o.status = $${params.length}`;
  }

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM orders o WHERE ${where}`,
    params,
  );

  params.push(pageSize, (page - 1) * pageSize);
  const { rows } = await pool.query(
    `SELECT o.*,
            COALESCE(items.item_count, 0) AS item_count,
            items.preview
     FROM orders o
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS item_count,
              JSON_AGG(JSON_BUILD_OBJECT(
                'name', oi.name, 'imageUrl', oi.image_url, 'quantity', oi.quantity
              ) ORDER BY oi.created_at) AS preview
       FROM order_items oi WHERE oi.order_id = o.order_id
     ) items ON TRUE
     WHERE ${where}
     ORDER BY o.placed_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  res.json(
    paginated(
      rows.map((row) => ({
        orderId: row.order_id,
        orderNumber: row.order_number,
        status: row.status,
        totalCents: row.total_cents,
        currency: row.currency,
        itemCount: row.item_count,
        items: row.preview ?? [],
        placedAt: row.placed_at,
      })),
      { page, pageSize, total: countRows[0].total },
    ),
  );
});

export const getOrder = asyncHandler(async (req, res) => {
  const { orderId } = req.params;
  const isAdmin = req.auth.role === "admin";

  // Ownership is enforced in the WHERE clause, not after the fetch, so a
  // mistake cannot leak another customer's order body.
  const { rows } = await pool.query(
    `SELECT * FROM orders WHERE order_id = $1 AND ($2::boolean OR user_id = $3)`,
    [orderId, isAdmin, req.auth.userId],
  );
  const order = rows[0];
  if (!order) throw orderNotFound();

  const [{ rows: items }, { rows: events }, { rows: shipments }] = await Promise.all([
    pool.query("SELECT * FROM order_items WHERE order_id = $1 ORDER BY created_at", [orderId]),
    pool.query("SELECT * FROM order_events WHERE order_id = $1 ORDER BY created_at", [orderId]),
    pool.query(
      `SELECT shipment_id, carrier, service_level, tracking_number, status,
              estimated_delivery, shipped_at, delivered_at
       FROM shipments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [orderId],
    ),
  ]);

  const shipment = shipments[0]
    ? {
        shipmentId: shipments[0].shipment_id,
        carrier: shipments[0].carrier,
        serviceLevel: shipments[0].service_level,
        trackingNumber: shipments[0].tracking_number,
        status: shipments[0].status,
        estimatedDelivery: shipments[0].estimated_delivery,
        shippedAt: shipments[0].shipped_at,
        deliveredAt: shipments[0].delivered_at,
      }
    : null;

  res.json({ order: toPublicOrder(order, items, events, shipment) });
});

export const getOrderByNumber = asyncHandler(async (req, res, next) => {
  const { rows } = await pool.query(
    "SELECT order_id FROM orders WHERE order_number = $1 AND user_id = $2",
    [req.params.orderNumber, req.auth.userId],
  );
  if (!rows[0]) throw orderNotFound();
  req.params.orderId = rows[0].order_id;
  // `getOrder` is wrapped in asyncHandler, which requires all three arguments;
  // calling it with just (req, res) makes the wrapper reject.
  return getOrder(req, res, next);
});

export const cancelOrder = asyncHandler(async (req, res) => {
  const { orderId } = req.params;
  const userId = req.auth.userId;
  const isAdmin = req.auth.role === "admin";

  const order = await withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM orders WHERE order_id = $1 AND ($2::boolean OR user_id = $3) FOR UPDATE`,
      [orderId, isAdmin, userId],
    );
    const existing = rows[0];
    if (!existing) throw orderNotFound();

    if (existing.status === "cancelled") return existing; // idempotent

    if (!CUSTOMER_CANCELLABLE.has(existing.status) && !isAdmin) {
      throw new AppError({
        message: `An order that is already ${existing.status} cannot be cancelled. Please contact support.`,
        statusCode: 409,
        errorCode: ErrorCodes.ORDER_NOT_CANCELLABLE,
      });
    }
    if (!ALLOWED_TRANSITIONS[existing.status].includes("cancelled")) {
      throw new AppError({
        message: `Cannot cancel an order in state "${existing.status}".`,
        statusCode: 409,
        errorCode: ErrorCodes.ORDER_NOT_CANCELLABLE,
      });
    }

    const hoursSincePlaced = (Date.now() - new Date(existing.placed_at).getTime()) / 3_600_000;
    if (!isAdmin && hoursSincePlaced > config.CANCELLATION_WINDOW_HOURS) {
      throw new AppError({
        message: `Orders can only be cancelled within ${config.CANCELLATION_WINDOW_HOURS} hours. Please contact support.`,
        statusCode: 409,
        errorCode: ErrorCodes.ORDER_NOT_CANCELLABLE,
      });
    }

    const { rows: updated } = await client.query(
      `UPDATE orders SET status = 'cancelled', cancelled_at = NOW()
       WHERE order_id = $1 RETURNING *`,
      [orderId],
    );
    await client.query(
      `INSERT INTO order_events (order_id, status, note, actor)
       VALUES ($1, 'cancelled', $2, $3)`,
      [orderId, req.body?.reason ?? "Cancelled by customer", isAdmin ? "admin" : "customer"],
    );
    await client.query(
      `UPDATE shipments SET status = 'cancelled'
       WHERE order_id = $1 AND status IN ('pending', 'label_created')`,
      [orderId],
    );

    return updated[0];
  });

  // Put the stock back. Runs after commit so a slow inventory call cannot hold
  // the order row lock open.
  await restockCancelledOrder(orderId, { userId, role: req.auth.role });

  logger.info({ orderId, userId }, "order cancelled");
  res.json({
    order: { orderId: order.order_id, orderNumber: order.order_number, status: "cancelled" },
    message: "Order cancelled. Any payment will be refunded within 5 business days.",
  });
});

/** Admin-driven transition, e.g. warehouse marks an order shipped. */
export const updateStatus = asyncHandler(async (req, res) => {
  const { orderId } = req.params;
  const { status: nextStatus, note } = req.body;

  const order = await withTransaction(pool, async (client) => {
    const { rows } = await client.query("SELECT * FROM orders WHERE order_id = $1 FOR UPDATE", [
      orderId,
    ]);
    const existing = rows[0];
    if (!existing) throw orderNotFound();

    if (existing.status === nextStatus) return existing;

    if (!ALLOWED_TRANSITIONS[existing.status]?.includes(nextStatus)) {
      throw new AppError({
        message: `Cannot move an order from "${existing.status}" to "${nextStatus}".`,
        statusCode: 409,
        errorCode: "INVALID_STATUS_TRANSITION",
        details: { from: existing.status, allowed: ALLOWED_TRANSITIONS[existing.status] ?? [] },
      });
    }

    const { rows: updated } = await client.query(
      `UPDATE orders SET status = $2,
              cancelled_at = CASE WHEN $2 = 'cancelled' THEN NOW() ELSE cancelled_at END
       WHERE order_id = $1 RETURNING *`,
      [orderId, nextStatus],
    );
    await client.query(
      `INSERT INTO order_events (order_id, status, note, actor)
       VALUES ($1, $2, $3, 'admin')`,
      [orderId, nextStatus, note ?? null],
    );
    return updated[0];
  });

  logger.info({ orderId, status: nextStatus }, "order status updated");
  res.json({
    order: { orderId: order.order_id, status: order.status },
    message: "Status updated.",
  });
});

/** Admin list across all customers. */
export const listAllOrders = asyncHandler(async (req, res) => {
  const { page, pageSize, status } = req.query;
  const params = [];
  let where = "TRUE";

  if (status) {
    params.push(status);
    where = `o.status = $${params.length}`;
  }

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM orders o WHERE ${where}`,
    params,
  );

  params.push(pageSize, (page - 1) * pageSize);
  const { rows } = await pool.query(
    `SELECT o.order_id, o.order_number, o.status, o.total_cents, o.currency,
            o.placed_at, u.email, u.username
     FROM orders o JOIN users u ON u.user_id = o.user_id
     WHERE ${where}
     ORDER BY o.placed_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  res.json(
    paginated(
      rows.map((r) => ({
        orderId: r.order_id,
        orderNumber: r.order_number,
        status: r.status,
        totalCents: r.total_cents,
        currency: r.currency,
        placedAt: r.placed_at,
        customer: { email: r.email, username: r.username },
      })),
      { page, pageSize, total: countRows[0].total },
    ),
  );
});

async function restockCancelledOrder(orderId, auth) {
  try {
    const { rows } = await pool.query("SELECT reservation_id FROM orders WHERE order_id = $1", [
      orderId,
    ]);
    const reservationId = rows[0]?.reservation_id;
    if (!reservationId) return;

    const { rows: items } = await pool.query(
      "SELECT product_id, quantity FROM order_items WHERE order_id = $1",
      [orderId],
    );
    if (items.length === 0) return;

    // The reservation was committed at checkout, so releasing it is a no-op.
    // Stock is returned through inventory's internal restock endpoint, which
    // trusts any valid internal token rather than requiring the admin role —
    // a service quietly escalating its own role to reach an admin API would
    // make the authorisation model meaningless.
    await inventoryClient.post("/internal/restock", {
      auth,
      body: {
        reason: "order_cancelled",
        reference: orderId,
        items: items.map((item) => ({ productId: item.product_id, quantity: item.quantity })),
      },
    });
  } catch (err) {
    logger.error(
      { err: { message: err.message }, orderId },
      "failed to restock cancelled order; requires manual reconciliation",
    );
  }
}

const orderNotFound = () =>
  new AppError({
    message: "Order not found.",
    statusCode: 404,
    errorCode: ErrorCodes.ORDER_NOT_FOUND,
  });
