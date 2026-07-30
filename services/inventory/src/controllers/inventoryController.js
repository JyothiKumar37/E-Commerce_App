import { AppError, ErrorCodes, asyncHandler } from "@ecom/shared";
import { pool } from "../lib/db.js";
import {
  adjustStock,
  commit,
  getStock,
  release,
  reserve,
  restock,
  sweepExpiredReservations,
} from "../services/inventoryService.js";

export const listStock = asyncHandler(async (req, res) => {
  const productIds = Array.isArray(req.query.productIds)
    ? req.query.productIds
    : [req.query.productIds];
  res.json({ stock: await getStock(productIds) });
});

export const getStockForProduct = asyncHandler(async (req, res) => {
  const [stock] = await getStock([req.params.productId]);
  if (!stock) {
    throw new AppError({
      message: "No inventory record for that product.",
      statusCode: 404,
      errorCode: ErrorCodes.PRODUCT_NOT_FOUND,
    });
  }
  res.json({ stock });
});

export const createReservation = asyncHandler(async (req, res) => {
  const reservation = await reserve({
    userId: req.auth.userId,
    orderId: req.body.orderId,
    items: req.body.items,
    ttlSeconds: req.body.ttlSeconds,
  });
  res.status(201).json({ reservation });
});

export const commitReservation = asyncHandler(async (req, res) => {
  res.json(await commit({ reservationId: req.params.reservationId, orderId: req.body?.orderId }));
});

export const releaseReservation = asyncHandler(async (req, res) => {
  res.json(await release({ reservationId: req.params.reservationId }));
});

export const restockItems = asyncHandler(async (req, res) => {
  res.json(
    await restock({
      items: req.body.items,
      reason: req.body.reason,
      reference: req.body.reference,
    }),
  );
});

export const adjust = asyncHandler(async (req, res) => {
  const stock = await adjustStock({
    productId: req.params.productId,
    delta: req.body.delta,
    reason: req.body.reason,
    reference: req.body.reference,
  });
  res.json({ stock, message: "Stock adjusted." });
});

export const listLowStock = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT i.product_id, p.sku, p.name, i.available, i.reserved, i.reorder_level
     FROM inventory i JOIN products p ON p.product_id = i.product_id
     WHERE i.available <= i.reorder_level AND p.is_active
     ORDER BY i.available ASC
     LIMIT 200`,
  );
  res.json({
    items: rows.map((r) => ({
      productId: r.product_id,
      sku: r.sku,
      name: r.name,
      available: r.available,
      reserved: r.reserved,
      reorderLevel: r.reorder_level,
    })),
  });
});

export const sweep = asyncHandler(async (req, res) => {
  res.json(await sweepExpiredReservations());
});
