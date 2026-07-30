import { Joi } from "@ecom/shared";

export const chargeSchema = Joi.object({
  orderId: Joi.string().uuid().required(),
  amountCents: Joi.number().integer().min(1).max(100_000_000).required(),
  currency: Joi.string().uppercase().length(3).default("EUR"),
  method: Joi.string().valid("card", "paypal", "sepa", "invoice").required(),
  /**
   * A token from the PSP's client SDK. Raw PANs are rejected outright — see
   * the `custom` guard below.
   */
  paymentToken: Joi.string().trim().min(4).max(255).required(),
  cardLast4: Joi.string()
    .pattern(/^\d{4}$/)
    .allow(null),
  cardBrand: Joi.string().max(30).allow("", null),
}).custom((value, helpers) => {
  // Defence in depth: refuse anything that looks like a card number so a
  // misconfigured client cannot push a PAN into our logs or database.
  if (/^\d{12,19}$/.test(value.paymentToken.replace(/[\s-]/g, ""))) {
    return helpers.message(
      "paymentToken must be a provider token, not a card number. Tokenise the card client-side.",
    );
  }
  return value;
});

export const paymentIdParam = Joi.object({
  paymentId: Joi.string().uuid().required(),
}).unknown(true);
