import { AppError, ErrorCodes, withRetryableTransaction } from "@ecom/shared";
import { config } from "../config.js";
import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";

/**
 * Stock is the one resource two customers can genuinely fight over, so every
 * mutation runs inside a transaction that takes row locks in a deterministic
 * order.
 *
 * Rows are always locked sorted by product_id. Two concurrent checkouts for
 * the same pair of products in opposite cart order would otherwise deadlock:
 * A locks P1 and waits on P2 while B locks P2 and waits on P1.
 */

export async function getStock(productIds) {
  const { rows } = await pool.query(
    `SELECT i.product_id, i.available, i.reserved, i.reorder_level, i.warehouse_code,
            p.name, p.sku
     FROM inventory i
     JOIN products p ON p.product_id = i.product_id
     WHERE i.product_id = ANY($1::uuid[])`,
    [productIds],
  );

  return rows.map((row) => ({
    productId: row.product_id,
    sku: row.sku,
    name: row.name,
    available: row.available,
    reserved: row.reserved,
    inStock: row.available > 0,
    lowStock: row.available > 0 && row.available <= row.reorder_level,
    warehouseCode: row.warehouse_code,
  }));
}

/**
 * Moves stock from `available` to `reserved` and records a reservation that
 * expires. Returns the reservation id, which checkout later commits or releases.
 */
export async function reserve({
  userId,
  orderId,
  items,
  ttlSeconds = config.RESERVATION_TTL_SECONDS,
}) {
  const sorted = [...items].sort((a, b) => (a.productId < b.productId ? -1 : 1));

  return withRetryableTransaction(pool, async (client) => {
    const productIds = sorted.map((i) => i.productId);

    const { rows: stock } = await client.query(
      `SELECT i.product_id, i.available, p.name
       FROM inventory i
       JOIN products p ON p.product_id = i.product_id
       WHERE i.product_id = ANY($1::uuid[])
       ORDER BY i.product_id
       FOR UPDATE OF i`,
      [productIds],
    );

    const stockById = new Map(stock.map((row) => [row.product_id, row]));
    const shortfalls = [];

    for (const item of sorted) {
      const row = stockById.get(item.productId);
      if (!row) {
        shortfalls.push({ productId: item.productId, requested: item.quantity, available: 0 });
      } else if (row.available < item.quantity) {
        shortfalls.push({
          productId: item.productId,
          name: row.name,
          requested: item.quantity,
          available: row.available,
        });
      }
    }

    // Reject the whole reservation rather than partially fulfilling it: a
    // half-reserved order is harder to reason about than a clean failure.
    if (shortfalls.length > 0) {
      throw new AppError({
        message:
          shortfalls.length === 1 && shortfalls[0].name
            ? `Only ${shortfalls[0].available} of ${shortfalls[0].name} left in stock.`
            : "Some items in your order are no longer available in the requested quantity.",
        statusCode: 409,
        errorCode: ErrorCodes.INSUFFICIENT_STOCK,
        details: { shortfalls },
      });
    }

    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const { rows: reservationRows } = await client.query(
      `INSERT INTO inventory_reservations (order_id, user_id, expires_at)
       VALUES ($1, $2, $3)
       RETURNING reservation_id, expires_at`,
      [orderId ?? null, userId ?? null, expiresAt],
    );
    const reservation = reservationRows[0];

    for (const item of sorted) {
      await client.query(
        `UPDATE inventory
         SET available = available - $2, reserved = reserved + $2
         WHERE product_id = $1`,
        [item.productId, item.quantity],
      );
      await client.query(
        `INSERT INTO inventory_reservation_items (reservation_id, product_id, quantity)
         VALUES ($1, $2, $3)`,
        [reservation.reservation_id, item.productId, item.quantity],
      );
      await client.query(
        `INSERT INTO inventory_ledger (product_id, delta, reason, reference)
         VALUES ($1, $2, 'reserve', $3)`,
        [item.productId, -item.quantity, reservation.reservation_id],
      );
    }

    logger.info(
      { reservationId: reservation.reservation_id, items: sorted.length, userId },
      "stock reserved",
    );

    return {
      reservationId: reservation.reservation_id,
      expiresAt: reservation.expires_at,
      items: sorted,
    };
  });
}

/**
 * Confirms a reservation after payment: the held stock leaves `reserved` for
 * good. Idempotent — committing an already-committed reservation is a no-op,
 * because the payment webhook may legitimately arrive twice.
 */
export async function commit({ reservationId, orderId }) {
  return withRetryableTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT reservation_id, status, expires_at
       FROM inventory_reservations
       WHERE reservation_id = $1
       FOR UPDATE`,
      [reservationId],
    );
    const reservation = rows[0];

    if (!reservation) {
      throw new AppError({
        message: "Reservation not found.",
        statusCode: 404,
        errorCode: "RESERVATION_NOT_FOUND",
      });
    }
    if (reservation.status === "committed") {
      return { reservationId, status: "committed", alreadyCommitted: true };
    }
    if (reservation.status !== "held") {
      throw new AppError({
        message: `This reservation has already been ${reservation.status} and cannot be committed.`,
        statusCode: 409,
        errorCode: ErrorCodes.RESERVATION_EXPIRED,
      });
    }

    const { rows: items } = await client.query(
      `SELECT product_id, quantity FROM inventory_reservation_items
       WHERE reservation_id = $1 ORDER BY product_id`,
      [reservationId],
    );

    for (const item of items) {
      await client.query("UPDATE inventory SET reserved = reserved - $2 WHERE product_id = $1", [
        item.product_id,
        item.quantity,
      ]);
      await client.query(
        `INSERT INTO inventory_ledger (product_id, delta, reason, reference)
         VALUES ($1, 0, 'commit', $2)`,
        [item.product_id, reservationId],
      );
    }

    await client.query(
      `UPDATE inventory_reservations
       SET status = 'committed', order_id = COALESCE($2, order_id)
       WHERE reservation_id = $1`,
      [reservationId, orderId ?? null],
    );

    logger.info({ reservationId, orderId }, "reservation committed");
    return { reservationId, status: "committed", alreadyCommitted: false };
  });
}

/** Returns held stock to `available`. Also idempotent. */
export async function release({ reservationId, reason = "released" }) {
  return withRetryableTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT reservation_id, status FROM inventory_reservations
       WHERE reservation_id = $1 FOR UPDATE`,
      [reservationId],
    );
    const reservation = rows[0];

    if (!reservation) {
      throw new AppError({
        message: "Reservation not found.",
        statusCode: 404,
        errorCode: "RESERVATION_NOT_FOUND",
      });
    }
    if (reservation.status !== "held") {
      return { reservationId, status: reservation.status, alreadyResolved: true };
    }

    const { rows: items } = await client.query(
      `SELECT product_id, quantity FROM inventory_reservation_items
       WHERE reservation_id = $1 ORDER BY product_id`,
      [reservationId],
    );

    for (const item of items) {
      await client.query(
        `UPDATE inventory
         SET available = available + $2, reserved = GREATEST(reserved - $2, 0)
         WHERE product_id = $1`,
        [item.product_id, item.quantity],
      );
      await client.query(
        `INSERT INTO inventory_ledger (product_id, delta, reason, reference)
         VALUES ($1, $2, $3, $4)`,
        [item.product_id, item.quantity, reason, reservationId],
      );
    }

    await client.query(`UPDATE inventory_reservations SET status = $2 WHERE reservation_id = $1`, [
      reservationId,
      reason === "expired" ? "expired" : "released",
    ]);

    logger.info({ reservationId, reason, items: items.length }, "reservation released");
    return { reservationId, status: "released", alreadyResolved: false };
  });
}

/** Admin restock / manual correction. */
export async function adjustStock({ productId, delta, reason, reference }) {
  return withRetryableTransaction(pool, async (client) => {
    const { rows } = await client.query(
      "SELECT available FROM inventory WHERE product_id = $1 FOR UPDATE",
      [productId],
    );
    if (!rows[0]) {
      throw new AppError({
        message: "No inventory record exists for that product.",
        statusCode: 404,
        errorCode: ErrorCodes.PRODUCT_NOT_FOUND,
      });
    }

    const next = rows[0].available + delta;
    if (next < 0) {
      throw new AppError({
        message: `Cannot reduce stock by ${Math.abs(delta)}; only ${rows[0].available} available.`,
        statusCode: 409,
        errorCode: ErrorCodes.INSUFFICIENT_STOCK,
      });
    }

    const { rows: updated } = await client.query(
      `UPDATE inventory SET available = $2 WHERE product_id = $1
       RETURNING product_id, available, reserved`,
      [productId, next],
    );
    await client.query(
      `INSERT INTO inventory_ledger (product_id, delta, reason, reference)
       VALUES ($1, $2, $3, $4)`,
      [productId, delta, reason, reference ?? null],
    );

    // Stock crossing the zero boundary changes the product's `inStock` facet,
    // so the search index needs to know.
    if ((rows[0].available === 0) !== (next === 0)) {
      await client.query(
        "INSERT INTO catalog_outbox (product_id, operation) VALUES ($1, 'upsert')",
        [productId],
      );
    }

    return {
      productId: updated[0].product_id,
      available: updated[0].available,
      reserved: updated[0].reserved,
    };
  });
}

/**
 * Returns stock for a cancelled or returned order.
 *
 * Separate from `adjustStock` because the callers are different: this is a
 * service-to-service operation triggered by a legitimate cancellation, whereas
 * `adjustStock` is an operator correcting the books and is admin-gated. Keeping
 * them apart means order-status does not need to pretend to be an admin.
 */
export async function restock({ items, reason, reference }) {
  const sorted = [...items].sort((a, b) => (a.productId < b.productId ? -1 : 1));

  return withRetryableTransaction(pool, async (client) => {
    const restored = [];

    for (const item of sorted) {
      const { rows } = await client.query(
        `UPDATE inventory SET available = available + $2
         WHERE product_id = $1
         RETURNING product_id, available, reserved`,
        [item.productId, item.quantity],
      );

      // A product deleted since the order was placed has no inventory row;
      // skip it rather than failing the whole cancellation.
      if (!rows[0]) {
        logger.warn({ productId: item.productId, reference }, "restock skipped: no inventory row");
        continue;
      }

      await client.query(
        `INSERT INTO inventory_ledger (product_id, delta, reason, reference)
         VALUES ($1, $2, $3, $4)`,
        [item.productId, item.quantity, reason, reference ?? null],
      );

      // Coming back from zero flips the product's inStock facet.
      if (rows[0].available === item.quantity) {
        await client.query(
          "INSERT INTO catalog_outbox (product_id, operation) VALUES ($1, 'upsert')",
          [item.productId],
        );
      }

      restored.push({ productId: rows[0].product_id, available: rows[0].available });
    }

    logger.info({ reference, reason, count: restored.length }, "stock restocked");
    return { restored };
  });
}

/**
 * Releases reservations that outlived their TTL — abandoned checkouts, crashed
 * clients, or a payment provider that never answered. Without this, stock
 * leaks out of `available` permanently.
 */
export async function sweepExpiredReservations() {
  const { rows } = await pool.query(
    `SELECT reservation_id FROM inventory_reservations
     WHERE status = 'held' AND expires_at < NOW()
     LIMIT 100`,
  );

  let released = 0;
  for (const row of rows) {
    try {
      await release({ reservationId: row.reservation_id, reason: "expired" });
      released += 1;
    } catch (err) {
      logger.error(
        { err: { message: err.message }, reservationId: row.reservation_id },
        "failed to release expired reservation",
      );
    }
  }

  if (released > 0) logger.info({ released }, "expired reservations swept");
  return { released };
}

let sweeper = null;

export function startSweeper() {
  if (!config.SWEEPER_ENABLED) return;
  sweeper = setInterval(() => {
    sweepExpiredReservations().catch((err) =>
      logger.error({ err: { message: err.message } }, "reservation sweep failed"),
    );
  }, config.SWEEPER_INTERVAL_MS);
  sweeper.unref();
  logger.info({ intervalMs: config.SWEEPER_INTERVAL_MS }, "reservation sweeper started");
}

export function stopSweeper() {
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
}
