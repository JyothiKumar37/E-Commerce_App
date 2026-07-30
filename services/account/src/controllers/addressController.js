import { AppError, ErrorCodes, asyncHandler, buildUpdateSet, withTransaction } from "@ecom/shared";
import { config } from "../config.js";
import { pool } from "../lib/db.js";

const ADDRESS_COLUMNS = `address_id, user_id, address_type, recipient_name, address_line1,
                         address_line2, city, state, country, zip, phone, is_default,
                         effective_date, created_at, updated_at`;

const toPublicAddress = (row) => ({
  addressId: row.address_id,
  addressType: row.address_type,
  recipientName: row.recipient_name,
  addressLine1: row.address_line1,
  addressLine2: row.address_line2,
  city: row.city,
  state: row.state,
  country: row.country,
  zip: row.zip,
  phone: row.phone,
  isDefault: row.is_default,
  effectiveDate: row.effective_date,
  createdAt: row.created_at,
});

export const listAddresses = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ${ADDRESS_COLUMNS} FROM addresses
     WHERE user_id = $1
     ORDER BY is_default DESC, created_at DESC`,
    [req.auth.userId],
  );

  // An empty address book is a valid state, not an error. The old handler
  // returned 404 ADDRESS_NOT_FOUND whenever a user had no addresses yet, so a
  // brand-new account saw an error on the page that exists to add their first.
  res.json({ addresses: rows.map(toPublicAddress), total: rows.length });
});

export const getAddress = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ${ADDRESS_COLUMNS} FROM addresses WHERE address_id = $1 AND user_id = $2`,
    [req.params.addressId, req.auth.userId],
  );
  if (!rows[0]) throw addressNotFound();
  res.json({ address: toPublicAddress(rows[0]) });
});

export const createAddress = asyncHandler(async (req, res) => {
  const userId = req.auth.userId;
  const payload = req.body;

  const address = await withTransaction(pool, async (client) => {
    const { rows: countRows } = await client.query(
      "SELECT COUNT(*)::int AS count FROM addresses WHERE user_id = $1",
      [userId],
    );
    const existingCount = countRows[0].count;

    if (existingCount >= config.MAX_ADDRESSES_PER_USER) {
      throw new AppError({
        message: `You can save at most ${config.MAX_ADDRESSES_PER_USER} addresses.`,
        statusCode: 409,
        errorCode: "ADDRESS_LIMIT_REACHED",
      });
    }

    // The first address a user saves becomes their default automatically.
    const shouldBeDefault = payload.is_default || existingCount === 0;
    if (shouldBeDefault) await clearDefault(client, userId);

    const { rows } = await client.query(
      `INSERT INTO addresses (user_id, address_type, recipient_name, address_line1, address_line2,
                              city, state, country, zip, phone, is_default, effective_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING ${ADDRESS_COLUMNS}`,
      [
        userId,
        payload.address_type,
        payload.recipient_name,
        payload.address_line1,
        payload.address_line2 || null,
        payload.city,
        payload.state || null,
        payload.country,
        payload.zip,
        payload.phone || null,
        shouldBeDefault,
        payload.effective_date,
      ],
    );
    return rows[0];
  });

  res.status(201).json({ address: toPublicAddress(address), message: "Address added." });
});

/**
 * The address id lives in the path, not the body.
 *
 * The old routes were `PUT /me/addresses` and `DELETE /me/addresses` with the
 * target id buried in the request body — unRESTful, un-cacheable, and it made
 * `DELETE` require a body, which several HTTP clients and proxies strip.
 */
export const updateAddress = asyncHandler(async (req, res) => {
  const userId = req.auth.userId;
  const { addressId } = req.params;

  const updated = await withTransaction(pool, async (client) => {
    const { rows: owned } = await client.query(
      "SELECT address_id FROM addresses WHERE address_id = $1 AND user_id = $2 FOR UPDATE",
      [addressId, userId],
    );
    if (!owned[0]) throw addressNotFound();

    if (req.body.is_default === true) await clearDefault(client, userId);

    const { clause, values, nextIndex } = buildUpdateSet(req.body);

    const { rows } = await client.query(
      `UPDATE addresses SET ${clause}
       WHERE address_id = $${nextIndex} AND user_id = $${nextIndex + 1}
       RETURNING ${ADDRESS_COLUMNS}`,
      [...values, addressId, userId],
    );
    return rows[0];
  });

  res.json({ address: toPublicAddress(updated), message: "Address updated." });
});

export const setDefaultAddress = asyncHandler(async (req, res) => {
  const userId = req.auth.userId;
  const { addressId } = req.params;

  const updated = await withTransaction(pool, async (client) => {
    const { rows: owned } = await client.query(
      "SELECT address_id FROM addresses WHERE address_id = $1 AND user_id = $2 FOR UPDATE",
      [addressId, userId],
    );
    if (!owned[0]) throw addressNotFound();

    await clearDefault(client, userId);

    const { rows } = await client.query(
      `UPDATE addresses SET is_default = TRUE
       WHERE address_id = $1 AND user_id = $2
       RETURNING ${ADDRESS_COLUMNS}`,
      [addressId, userId],
    );
    return rows[0];
  });

  res.json({ address: toPublicAddress(updated), message: "Default address updated." });
});

export const deleteAddress = asyncHandler(async (req, res) => {
  const userId = req.auth.userId;
  const { addressId } = req.params;

  await withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `DELETE FROM addresses WHERE address_id = $1 AND user_id = $2
       RETURNING is_default`,
      [addressId, userId],
    );
    if (!rows[0]) throw addressNotFound();

    // Promote the most recent remaining address so the user always has a
    // default to check out with.
    if (rows[0].is_default) {
      await client.query(
        `UPDATE addresses SET is_default = TRUE
         WHERE address_id = (
           SELECT address_id FROM addresses WHERE user_id = $1
           ORDER BY created_at DESC LIMIT 1
         )`,
        [userId],
      );
    }
  });

  res.json({ message: "Address deleted." });
});

/**
 * Internal endpoint used by checkout to snapshot the delivery address. Not
 * exposed through the gateway's public route table.
 */
export const resolveAddressForOrder = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ${ADDRESS_COLUMNS} FROM addresses WHERE address_id = $1 AND user_id = $2`,
    [req.params.addressId, req.auth.userId],
  );
  if (!rows[0]) throw addressNotFound();
  res.json({ address: toPublicAddress(rows[0]) });
});

/**
 * `addresses_one_default_per_user` is a partial unique index, so two rows can
 * never both be default. Clearing first keeps the swap legal.
 */
async function clearDefault(client, userId) {
  await client.query("UPDATE addresses SET is_default = FALSE WHERE user_id = $1 AND is_default", [
    userId,
  ]);
}

const addressNotFound = () =>
  new AppError({
    message: "Address not found.",
    statusCode: 404,
    errorCode: ErrorCodes.ADDRESS_NOT_FOUND,
  });
