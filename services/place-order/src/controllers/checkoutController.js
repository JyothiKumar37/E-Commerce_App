import { asyncHandler, createIdempotencyStore } from "@ecom/shared";
import { redisClient } from "../lib/redis.js";
import { placeOrder, previewCheckout } from "../services/checkoutSaga.js";

const idempotency = createIdempotencyStore({
  redisClient,
  scope: "place-order",
  ttlSeconds: 24 * 3600,
});

export const preview = asyncHandler(async (req, res) => {
  const result = await previewCheckout({
    auth: { userId: req.auth.userId, role: req.auth.role },
    shippingAddressId: req.query.shippingAddressId || null,
  });
  res.json(result);
});

/**
 * Placing an order is the least idempotent thing a customer can do, so the
 * Idempotency-Key header is mandatory. A retried request returns the original
 * order instead of creating a second one.
 */
export const create = asyncHandler(async (req, res) => {
  const userId = req.auth.userId;
  const key = req.idempotencyKey;

  const claim = await idempotency.begin(userId, key, req.body);
  if (claim.status === "replay") {
    return res.status(claim.statusCode ?? 200).json({ ...claim.result, replayed: true });
  }

  try {
    const order = await placeOrder({
      userId,
      auth: { userId, role: req.auth.role },
      payload: req.body,
      idempotencyKey: key,
    });

    await idempotency.complete(userId, key, {
      result: { order },
      statusCode: 201,
      bodyHash: claim.bodyHash,
    });

    return res.status(201).json({ order });
  } catch (err) {
    // Release the claim so the customer can genuinely retry after fixing
    // whatever failed (declined card, changed address).
    await idempotency.abort(userId, key);
    throw err;
  }
});
