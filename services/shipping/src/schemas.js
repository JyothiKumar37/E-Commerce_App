import { Joi } from "@ecom/shared";

export const SHIPMENT_STATUSES = [
  "pending",
  "label_created",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "returned",
  "cancelled",
];

export const createShipmentSchema = Joi.object({
  orderId: Joi.string().uuid().required(),
  destination: Joi.object().unknown(true).required(),
  serviceLevel: Joi.string().valid("standard", "express", "overnight").default("standard"),
  carrier: Joi.string().max(50),
});

export const shipmentIdParam = Joi.object({
  shipmentId: Joi.string().uuid().required(),
}).unknown(true);

export const updateShipmentSchema = Joi.object({
  status: Joi.string()
    .valid(...SHIPMENT_STATUSES)
    .required(),
  location: Joi.string().max(200).allow("", null),
  note: Joi.string().max(500).allow("", null),
});

export const quoteSchema = Joi.object({
  country: Joi.string().min(2).max(100).required(),
  subtotalCents: Joi.number().integer().min(0).required(),
});

export const trackingNumberParam = Joi.object({
  trackingNumber: Joi.string().alphanum().max(64).required(),
}).unknown(true);

export const orderIdParam = Joi.object({
  orderId: Joi.string().uuid().required(),
}).unknown(true);
