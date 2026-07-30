import { Joi } from "@ecom/shared";

export const ORDER_STATUSES = [
  "pending_payment",
  "paid",
  "processing",
  "shipped",
  "delivered",
  "cancelled",
  "refunded",
  "failed",
];

export const listQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(50).default(10),
  status: Joi.string().valid(...ORDER_STATUSES),
});

export const orderIdParam = Joi.object({
  orderId: Joi.string().uuid().required(),
}).unknown(true);

export const orderNumberParam = Joi.object({
  orderNumber: Joi.string()
    .pattern(/^ORD-\d{8}-[A-Z0-9]{8}$/)
    .required(),
}).unknown(true);

export const cancelSchema = Joi.object({
  reason: Joi.string().trim().max(500).allow("", null).default(null),
});

export const updateStatusSchema = Joi.object({
  status: Joi.string()
    .valid(...ORDER_STATUSES)
    .required(),
  note: Joi.string().trim().max(500).allow("", null),
});
