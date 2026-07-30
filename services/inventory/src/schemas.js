import { Joi } from "@ecom/shared";

export const productIdParam = Joi.object({
  productId: Joi.string().uuid().required(),
}).unknown(true);

export const reservationIdParam = Joi.object({
  reservationId: Joi.string().uuid().required(),
}).unknown(true);

/** Accepts either repeated `?productIds=` params or one comma-separated value. */
export const stockQuerySchema = Joi.object({
  productIds: Joi.alternatives()
    .try(
      Joi.array().items(Joi.string().uuid()).min(1).max(200),
      Joi.string().custom((value) => value.split(",").map((v) => v.trim())),
    )
    .required(),
});

const lineItems = Joi.array()
  .items(
    Joi.object({
      productId: Joi.string().uuid().required(),
      quantity: Joi.number().integer().min(1).max(1000).required(),
    }),
  )
  .min(1)
  .max(100)
  .required();

export const reserveSchema = Joi.object({
  orderId: Joi.string().uuid().allow(null),
  items: lineItems,
  ttlSeconds: Joi.number().integer().min(60).max(3600),
});

export const restockSchema = Joi.object({
  items: lineItems,
  reason: Joi.string().trim().min(1).max(100).default("restock"),
  reference: Joi.string().trim().max(200).allow("", null),
});

export const adjustSchema = Joi.object({
  delta: Joi.number().integer().not(0).min(-1_000_000).max(1_000_000).required().messages({
    "any.invalid": "delta must be a non-zero integer.",
  }),
  reason: Joi.string().trim().min(1).max(100).required(),
  reference: Joi.string().trim().max(200).allow("", null),
});
