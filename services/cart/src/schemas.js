import { Joi } from "@ecom/shared";
import { config } from "./config.js";

export const addItemSchema = Joi.object({
  productId: Joi.string().uuid().required(),
  quantity: Joi.number().integer().min(1).max(config.MAX_QUANTITY_PER_ITEM).default(1),
});

/** Quantity 0 is allowed and means "remove this line". */
export const quantitySchema = Joi.object({
  quantity: Joi.number().integer().min(0).max(config.MAX_QUANTITY_PER_ITEM).required(),
});

export const productIdParam = Joi.object({
  productId: Joi.string().uuid().required(),
}).unknown(true);

export const mergeSchema = Joi.object({
  items: Joi.array()
    .items(
      Joi.object({
        productId: Joi.string().uuid().required(),
        quantity: Joi.number().integer().min(1).max(config.MAX_QUANTITY_PER_ITEM).required(),
      }),
    )
    .max(config.MAX_LINE_ITEMS)
    .required(),
});
