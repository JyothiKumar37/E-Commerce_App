import { Joi } from "@ecom/shared";

export const productIdParam = Joi.object({
  productId: Joi.string().uuid().required(),
}).unknown(true);

export const reviewIdParam = Joi.object({
  reviewId: Joi.string().uuid().required(),
}).unknown(true);

export const createReviewSchema = Joi.object({
  productId: Joi.string().uuid().required(),
  rating: Joi.number().integer().min(1).max(5).required().messages({
    "number.min": "Rating must be between 1 and 5.",
    "number.max": "Rating must be between 1 and 5.",
  }),
  title: Joi.string().trim().max(200).allow("", null).default(null),
  body: Joi.string().trim().min(10).max(5000).required().messages({
    "string.min": "Please write at least {#limit} characters.",
  }),
});

export const updateReviewSchema = Joi.object({
  rating: Joi.number().integer().min(1).max(5),
  title: Joi.string().trim().max(200).allow("", null),
  body: Joi.string().trim().min(10).max(5000),
})
  .min(1)
  .messages({ "object.min": "Provide at least one field to update." });

export const listQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(50).default(10),
  sort: Joi.string().valid("newest", "oldest", "highest", "lowest", "helpful").default("newest"),
  rating: Joi.number().integer().min(1).max(5),
});
