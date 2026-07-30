/**
 * All money is stored and transported as integer minor units (cents).
 * Floating-point currency arithmetic is the classic source of off-by-a-cent
 * order totals, so no float ever touches a price in this codebase.
 */

export const DEFAULT_CURRENCY = "EUR";

export function toCents(amount) {
  if (typeof amount === "number") return Math.round(amount * 100);
  const parsed = Number.parseFloat(String(amount));
  if (Number.isNaN(parsed)) throw new TypeError(`Cannot convert ${amount} to cents`);
  return Math.round(parsed * 100);
}

export function fromCents(cents) {
  return Number((cents / 100).toFixed(2));
}

export function formatMoney(cents, currency = DEFAULT_CURRENCY, locale = "de-DE") {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(cents / 100);
}

export const sumCents = (values) => values.reduce((acc, v) => acc + v, 0);

/** VAT applied to the goods subtotal only. */
export function calculateTax(subtotalCents, rate = 0.19) {
  return Math.round(subtotalCents * rate);
}

/** Free shipping above a threshold, flat rate otherwise. */
export function calculateShipping(
  subtotalCents,
  { freeThresholdCents = 5000, flatRateCents = 499 } = {},
) {
  if (subtotalCents <= 0) return 0;
  return subtotalCents >= freeThresholdCents ? 0 : flatRateCents;
}

/** Single source of truth for order totals; used by cart, checkout and orders. */
export function calculateTotals(
  items,
  { taxRate = 0.19, freeThresholdCents = 5000, flatRateCents = 499 } = {},
) {
  const subtotalCents = sumCents(items.map((i) => i.unitPriceCents * i.quantity));
  const shippingCents = calculateShipping(subtotalCents, { freeThresholdCents, flatRateCents });
  const taxCents = calculateTax(subtotalCents, taxRate);
  return {
    subtotalCents,
    shippingCents,
    taxCents,
    totalCents: subtotalCents + shippingCents + taxCents,
  };
}
