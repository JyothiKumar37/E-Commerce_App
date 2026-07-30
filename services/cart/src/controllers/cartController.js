import { asyncHandler } from "@ecom/shared";
import {
  addItem,
  clearCart,
  getCart,
  mergeCart,
  removeItem,
  setItemQuantity,
} from "../services/cartService.js";

/** Every cart operation is scoped to the authenticated caller. */
const context = (req) => ({
  userId: req.auth.userId,
  auth: { userId: req.auth.userId, role: req.auth.role },
});

export const show = asyncHandler(async (req, res) => {
  const { userId, auth } = context(req);
  res.json({ cart: await getCart(userId, auth) });
});

export const add = asyncHandler(async (req, res) => {
  const { userId, auth } = context(req);
  const cart = await addItem(userId, auth, req.body);
  res.status(201).json({ cart, message: "Item added to cart." });
});

export const updateQuantity = asyncHandler(async (req, res) => {
  const { userId, auth } = context(req);
  const cart = await setItemQuantity(userId, auth, req.params.productId, req.body.quantity);
  res.json({ cart, message: "Cart updated." });
});

export const remove = asyncHandler(async (req, res) => {
  const { userId, auth } = context(req);
  const cart = await removeItem(userId, auth, req.params.productId);
  res.json({ cart, message: "Item removed." });
});

export const clear = asyncHandler(async (req, res) => {
  await clearCart(req.auth.userId);
  res.json({ message: "Cart cleared." });
});

export const merge = asyncHandler(async (req, res) => {
  const { userId, auth } = context(req);
  const cart = await mergeCart(userId, auth, req.body.items);
  res.json({ cart, message: "Cart merged." });
});

/** Called by place-order once an order is committed. */
export const clearInternal = asyncHandler(async (req, res) => {
  await clearCart(req.auth.userId);
  res.status(204).end();
});
