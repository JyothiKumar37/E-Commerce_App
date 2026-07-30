import { AppError, ErrorCodes, asyncHandler, withTransaction } from "@ecom/shared";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { pool } from "../lib/db.js";
import {
  TRANSIT_DAYS,
  estimateDelivery,
  generateTrackingNumber,
} from "../services/shippingRules.js";

const toPublicShipment = (row, events = []) => ({
  shipmentId: row.shipment_id,
  orderId: row.order_id,
  carrier: row.carrier,
  serviceLevel: row.service_level,
  trackingNumber: row.tracking_number,
  status: row.status,
  destination: row.destination,
  estimatedDelivery: row.estimated_delivery,
  shippedAt: row.shipped_at,
  deliveredAt: row.delivered_at,
  createdAt: row.created_at,
  events: events.map((e) => ({
    status: e.status,
    location: e.location,
    note: e.note,
    at: e.occurred_at,
  })),
});

export const createShipment = asyncHandler(async (req, res) => {
  const { orderId, destination, serviceLevel, carrier } = req.body;

  const shipment = await withTransaction(pool, async (client) => {
    const { rows: orderRows } = await client.query(
      "SELECT order_id, user_id, status FROM orders WHERE order_id = $1",
      [orderId],
    );
    if (!orderRows[0]) {
      throw new AppError({
        message: "Order not found.",
        statusCode: 404,
        errorCode: ErrorCodes.ORDER_NOT_FOUND,
      });
    }

    // Idempotent: checkout retries must not create a second shipment.
    const { rows: existing } = await client.query(
      `SELECT * FROM shipments WHERE order_id = $1 AND status <> 'cancelled' LIMIT 1`,
      [orderId],
    );
    if (existing[0]) return existing[0];

    const chosenCarrier = carrier ?? config.DEFAULT_CARRIER;
    const { rows } = await client.query(
      `INSERT INTO shipments (order_id, carrier, service_level, tracking_number,
                              status, destination, estimated_delivery)
       VALUES ($1, $2, $3, $4, 'label_created', $5, $6)
       RETURNING *`,
      [
        orderId,
        chosenCarrier,
        serviceLevel,
        generateTrackingNumber(chosenCarrier),
        JSON.stringify(destination),
        estimateDelivery(serviceLevel),
      ],
    );

    await client.query(
      `INSERT INTO shipment_events (shipment_id, status, note)
       VALUES ($1, 'label_created', 'Shipping label created')`,
      [rows[0].shipment_id],
    );

    return rows[0];
  });

  logger.info({ shipmentId: shipment.shipment_id, orderId }, "shipment created");
  res.status(201).json({ shipment: toPublicShipment(shipment) });
});

export const getShipment = asyncHandler(async (req, res) => {
  const isAdmin = req.auth.role === "admin";
  const { rows } = await pool.query(
    `SELECT s.* FROM shipments s
     JOIN orders o ON o.order_id = s.order_id
     WHERE s.shipment_id = $1 AND ($2::boolean OR o.user_id = $3)`,
    [req.params.shipmentId, isAdmin, req.auth.userId],
  );
  if (!rows[0]) throw shipmentNotFound();

  const { rows: events } = await pool.query(
    "SELECT * FROM shipment_events WHERE shipment_id = $1 ORDER BY occurred_at",
    [req.params.shipmentId],
  );

  res.json({ shipment: toPublicShipment(rows[0], events) });
});

/** Public-ish tracking: still scoped to the authenticated owner. */
export const trackByNumber = asyncHandler(async (req, res) => {
  const isAdmin = req.auth.role === "admin";
  const { rows } = await pool.query(
    `SELECT s.* FROM shipments s
     JOIN orders o ON o.order_id = s.order_id
     WHERE s.tracking_number = $1 AND ($2::boolean OR o.user_id = $3)`,
    [req.params.trackingNumber, isAdmin, req.auth.userId],
  );
  if (!rows[0]) throw shipmentNotFound();

  const { rows: events } = await pool.query(
    "SELECT * FROM shipment_events WHERE shipment_id = $1 ORDER BY occurred_at",
    [rows[0].shipment_id],
  );

  res.json({ shipment: toPublicShipment(rows[0], events) });
});

export const listShipmentsForOrder = asyncHandler(async (req, res) => {
  const isAdmin = req.auth.role === "admin";
  const { rows } = await pool.query(
    `SELECT s.* FROM shipments s
     JOIN orders o ON o.order_id = s.order_id
     WHERE s.order_id = $1 AND ($2::boolean OR o.user_id = $3)
     ORDER BY s.created_at DESC`,
    [req.params.orderId, isAdmin, req.auth.userId],
  );
  res.json({ shipments: rows.map((r) => toPublicShipment(r)) });
});

/**
 * Carrier webhook equivalent. Advancing a shipment to `delivered` also moves
 * the order, so the two views never contradict each other.
 */
export const updateShipmentStatus = asyncHandler(async (req, res) => {
  const { shipmentId } = req.params;
  const { status, location, note } = req.body;

  const shipment = await withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      "SELECT * FROM shipments WHERE shipment_id = $1 FOR UPDATE",
      [shipmentId],
    );
    const existing = rows[0];
    if (!existing) throw shipmentNotFound();
    if (existing.status === status) return existing;

    const { rows: updated } = await client.query(
      `UPDATE shipments
       SET status = $2,
           shipped_at   = CASE WHEN $2 = 'in_transit' AND shipped_at IS NULL THEN NOW() ELSE shipped_at END,
           delivered_at = CASE WHEN $2 = 'delivered' THEN NOW() ELSE delivered_at END
       WHERE shipment_id = $1
       RETURNING *`,
      [shipmentId, status],
    );

    await client.query(
      `INSERT INTO shipment_events (shipment_id, status, location, note)
       VALUES ($1, $2, $3, $4)`,
      [shipmentId, status, location ?? null, note ?? null],
    );

    const orderStatus = { in_transit: "shipped", delivered: "delivered" }[status];
    if (orderStatus) {
      await client.query(
        `UPDATE orders SET status = $2
         WHERE order_id = $1 AND status NOT IN ('cancelled', 'refunded')`,
        [existing.order_id, orderStatus],
      );
      await client.query(
        `INSERT INTO order_events (order_id, status, note, actor)
         VALUES ($1, $2, $3, 'shipping-service')`,
        [existing.order_id, orderStatus, `Shipment ${status}`],
      );
    }

    return updated[0];
  });

  logger.info({ shipmentId, status }, "shipment status updated");
  res.json({ shipment: toPublicShipment(shipment), message: "Shipment updated." });
});

/** Delivery cost and ETA quote for the checkout page. */
export const quote = asyncHandler(async (req, res) => {
  const { subtotalCents } = req.body;
  const options = Object.entries(TRANSIT_DAYS).map(([level, days]) => {
    const baseCents = { standard: 499, express: 999, overnight: 1999 }[level];
    return {
      serviceLevel: level,
      // Free standard shipping above the threshold; premium tiers always cost.
      priceCents: level === "standard" && subtotalCents >= 5000 ? 0 : baseCents,
      transitDays: days,
      estimatedDelivery: estimateDelivery(level),
    };
  });
  res.json({ options });
});

const shipmentNotFound = () =>
  new AppError({
    message: "Shipment not found.",
    statusCode: 404,
    errorCode: ErrorCodes.SHIPMENT_NOT_FOUND,
  });
