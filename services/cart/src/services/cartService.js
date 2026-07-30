import {
  AppError,
  ErrorCodes,
  calculateTotals,
  createServiceClient,
  getJson,
  setJson,
} from "@ecom/shared";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { redisClient } from "../lib/redis.js";

/**
 * Carts live in Redis keyed by user id, with a TTL so abandoned carts self-clean.
 *
 * Only `{ productId, quantity, addedAt }` is persisted. Price, name and image
 * are re-resolved from the catalog on every read, so a cart can never quote a
 * stale price — the classic bug where a customer leaves a tab open across a
 * price change and checks out at the old total.
 */

const catalog = createServiceClient({
  name: "search",
  baseURL: config.SEARCH_SERVICE_URL,
  internalSecret: config.INTERNAL_JWT_SECRET,
  timeout: 4_000,
  logger,
});

const keyFor = (userId) => `cart:${userId}`;

async function readRaw(userId) {
  const cart = await getJson(redisClient, keyFor(userId));
  return cart ?? { items: [], updatedAt: null };
}

async function writeRaw(userId, cart) {
  const next = { ...cart, updatedAt: new Date().toISOString() };
  await setJson(redisClient, keyFor(userId), next, { ttlSeconds: config.CART_TTL_SECONDS });
  return next;
}

/**
 * Hydrates stored line items with live catalog data and recomputes totals.
 * Items whose product has since been deleted or deactivated are reported
 * separately rather than silently dropped, so the UI can tell the customer.
 */
export async function getCart(userId, auth) {
  const raw = await readRaw(userId);
  if (raw.items.length === 0) {
    return {
      items: [],
      unavailable: [],
      ...calculateTotals([]),
      currency: "EUR",
      itemCount: 0,
      updatedAt: raw.updatedAt,
    };
  }

  const productIds = raw.items.map((i) => i.productId);
  const { products } = await catalog.post("/products/lookup", {
    body: { productIds },
    auth,
  });
  const byId = new Map(products.map((p) => [p.productId, p]));

  const items = [];
  const unavailable = [];

  for (const line of raw.items) {
    const product = byId.get(line.productId);

    if (!product || !product.isActive) {
      unavailable.push({
        productId: line.productId,
        reason: "unavailable",
        quantity: line.quantity,
      });
      continue;
    }

    // Clamp to what is actually in stock instead of letting checkout fail later.
    const quantity = Math.min(line.quantity, product.available);
    if (quantity <= 0) {
      unavailable.push({
        productId: line.productId,
        name: product.name,
        reason: "out_of_stock",
        quantity: line.quantity,
      });
      continue;
    }

    items.push({
      productId: product.productId,
      sku: product.sku,
      name: product.name,
      imageUrl: product.imageUrl,
      unitPriceCents: product.priceCents,
      currency: product.currency,
      quantity,
      available: product.available,
      // Surfaced so the cart page can warn before the customer reaches payment.
      quantityAdjusted: quantity !== line.quantity,
      lineTotalCents: product.priceCents * quantity,
      addedAt: line.addedAt,
    });
  }

  return {
    items,
    unavailable,
    ...calculateTotals(items),
    currency: items[0]?.currency ?? "EUR",
    itemCount: items.reduce((sum, i) => sum + i.quantity, 0),
    updatedAt: raw.updatedAt,
  };
}

export async function addItem(userId, auth, { productId, quantity }) {
  const { products } = await catalog.post("/products/lookup", {
    body: { productIds: [productId] },
    auth,
  });
  const product = products[0];

  if (!product || !product.isActive) {
    throw new AppError({
      message: "Product not found.",
      statusCode: 404,
      errorCode: ErrorCodes.PRODUCT_NOT_FOUND,
    });
  }

  const raw = await readRaw(userId);
  const existing = raw.items.find((i) => i.productId === productId);
  const desired = (existing?.quantity ?? 0) + quantity;

  if (desired > config.MAX_QUANTITY_PER_ITEM) {
    throw new AppError({
      message: `You can add at most ${config.MAX_QUANTITY_PER_ITEM} of a single item.`,
      statusCode: 400,
      errorCode: "CART_QUANTITY_LIMIT",
    });
  }
  if (product.available < desired) {
    throw new AppError({
      message:
        product.available === 0
          ? `${product.name} is out of stock.`
          : `Only ${product.available} of ${product.name} left in stock.`,
      statusCode: 409,
      errorCode: ErrorCodes.INSUFFICIENT_STOCK,
      details: { productId, available: product.available, requested: desired },
    });
  }
  if (!existing && raw.items.length >= config.MAX_LINE_ITEMS) {
    throw new AppError({
      message: `A cart can hold at most ${config.MAX_LINE_ITEMS} different items.`,
      statusCode: 400,
      errorCode: "CART_ITEM_LIMIT",
    });
  }

  if (existing) existing.quantity = desired;
  else raw.items.push({ productId, quantity, addedAt: new Date().toISOString() });

  await writeRaw(userId, raw);
  return getCart(userId, auth);
}

export async function setItemQuantity(userId, auth, productId, quantity) {
  const raw = await readRaw(userId);
  const existing = raw.items.find((i) => i.productId === productId);

  if (!existing) {
    throw new AppError({
      message: "That item is not in your cart.",
      statusCode: 404,
      errorCode: "CART_ITEM_NOT_FOUND",
    });
  }

  if (quantity === 0) {
    raw.items = raw.items.filter((i) => i.productId !== productId);
    await writeRaw(userId, raw);
    return getCart(userId, auth);
  }

  const { products } = await catalog.post("/products/lookup", {
    body: { productIds: [productId] },
    auth,
  });
  const product = products[0];

  if (!product || !product.isActive) {
    raw.items = raw.items.filter((i) => i.productId !== productId);
    await writeRaw(userId, raw);
    throw new AppError({
      message: "That product is no longer available and has been removed from your cart.",
      statusCode: 409,
      errorCode: ErrorCodes.PRODUCT_NOT_FOUND,
    });
  }
  if (product.available < quantity) {
    throw new AppError({
      message: `Only ${product.available} of ${product.name} left in stock.`,
      statusCode: 409,
      errorCode: ErrorCodes.INSUFFICIENT_STOCK,
      details: { productId, available: product.available, requested: quantity },
    });
  }

  existing.quantity = quantity;
  await writeRaw(userId, raw);
  return getCart(userId, auth);
}

export async function removeItem(userId, auth, productId) {
  const raw = await readRaw(userId);
  const before = raw.items.length;
  raw.items = raw.items.filter((i) => i.productId !== productId);

  if (raw.items.length === before) {
    throw new AppError({
      message: "That item is not in your cart.",
      statusCode: 404,
      errorCode: "CART_ITEM_NOT_FOUND",
    });
  }

  await writeRaw(userId, raw);
  return getCart(userId, auth);
}

export async function clearCart(userId) {
  await redisClient.del(keyFor(userId));
}

/**
 * Merges a guest cart (held in the browser) into the signed-in user's cart.
 * Called immediately after sign-in so nothing is lost at the auth boundary.
 */
export async function mergeCart(userId, auth, guestItems) {
  const raw = await readRaw(userId);

  for (const guest of guestItems) {
    const existing = raw.items.find((i) => i.productId === guest.productId);
    if (existing) {
      // Take the larger quantity rather than summing: a user who added the
      // same item on two devices means "I want this", not "I want two".
      existing.quantity = Math.min(
        Math.max(existing.quantity, guest.quantity),
        config.MAX_QUANTITY_PER_ITEM,
      );
    } else if (raw.items.length < config.MAX_LINE_ITEMS) {
      raw.items.push({
        productId: guest.productId,
        quantity: Math.min(guest.quantity, config.MAX_QUANTITY_PER_ITEM),
        addedAt: new Date().toISOString(),
      });
    }
  }

  await writeRaw(userId, raw);
  return getCart(userId, auth);
}
