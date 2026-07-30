import { Joi } from "@ecom/shared";

export const placeOrderSchema = Joi.object({
  shippingAddressId: Joi.string().uuid().required(),
  billingAddress: Joi.object().unknown(true).allow(null),
  paymentMethod: Joi.string().valid("card", "paypal", "sepa", "invoice").required(),
  paymentToken: Joi.string().trim().min(4).max(255).required(),
  cardLast4: Joi.string()
    .pattern(/^\d{4}$/)
    .allow(null, ""),
  cardBrand: Joi.string().max(30).allow(null, ""),
  shippingMethod: Joi.string().valid("standard", "express", "overnight").default("standard"),
  /** What the client showed the customer; checkout aborts if it disagrees. */
  expectedTotalCents: Joi.number().integer().min(0).allow(null),
});

export const previewQuerySchema = Joi.object({
  shippingAddressId: Joi.string().uuid().allow(null, ""),
});
