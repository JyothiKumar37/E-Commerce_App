import { Joi } from "@ecom/shared";
import { config } from "./config.js";

export const limitQuery = Joi.object({
  limit: Joi.number().integer().min(1).max(50).default(config.DEFAULT_LIMIT),
});

export const productIdParam = Joi.object({
  productId: Joi.string().uuid().required(),
}).unknown(true);
