import { Joi } from "@ecom/shared";

export const searchSchema = Joi.object({
  q: Joi.string().trim().allow("").max(200).default(""),
  category: Joi.alternatives(
    Joi.string().max(100),
    Joi.array().items(Joi.string().max(100)).max(20),
  ),
  brand: Joi.alternatives(Joi.string().max(100), Joi.array().items(Joi.string().max(100)).max(20)),
  minPrice: Joi.number().min(0).max(1_000_000),
  maxPrice: Joi.number().min(0).max(1_000_000),
  inStock: Joi.boolean(),
  minRating: Joi.number().min(0).max(5),
  sort: Joi.string()
    .valid("relevance", "price_asc", "price_desc", "rating", "newest")
    .default("relevance"),
  page: Joi.number().integer().min(1).default(1),
  // Capped so a client cannot request a 10,000-document page and exhaust the
  // Elasticsearch result window.
  pageSize: Joi.number().integer().min(1).max(60).default(24),
}).custom((value, helpers) => {
  if (value.minPrice != null && value.maxPrice != null && value.minPrice > value.maxPrice) {
    return helpers.message("minPrice must not be greater than maxPrice");
  }
  return value;
});

export const listProductsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(60).default(24),
  category: Joi.string().max(100),
  brand: Joi.string().max(100),
  sort: Joi.string().valid("price_asc", "price_desc", "rating", "newest").default("newest"),
});

const attributeValue = Joi.alternatives(Joi.string().max(500), Joi.number(), Joi.boolean());

export const createProductSchema = Joi.object({
  sku: Joi.string()
    .trim()
    .uppercase()
    .pattern(/^[A-Z0-9-]{3,64}$/)
    .required()
    .messages({
      "string.pattern.base": "SKU may contain only uppercase letters, digits and hyphens.",
    }),
  name: Joi.string().trim().min(1).max(300).required(),
  description: Joi.string().trim().max(10_000).allow("").default(""),
  category: Joi.string().trim().min(1).max(100).required(),
  brand: Joi.string().trim().max(100).allow("", null),
  // Prices arrive as integer cents. Accepting floats invites rounding bugs.
  priceCents: Joi.number().integer().min(0).max(100_000_000).required().messages({
    "number.base": "priceCents must be an integer number of cents (e.g. 2499 for 24.99).",
  }),
  currency: Joi.string().uppercase().length(3).default("EUR"),
  imageUrl: Joi.string()
    .uri({ scheme: ["http", "https"] })
    .max(2048)
    .allow("", null),
  attributes: Joi.object()
    .pattern(/^[a-z][a-z0-9_]{0,49}$/, attributeValue)
    .max(50)
    .default({}),
  isActive: Joi.boolean().default(true),
  initialStock: Joi.number().integer().min(0).max(1_000_000).default(0),
});

export const updateProductSchema = Joi.object({
  sku: Joi.string()
    .trim()
    .uppercase()
    .pattern(/^[A-Z0-9-]{3,64}$/),
  name: Joi.string().trim().min(1).max(300),
  description: Joi.string().trim().max(10_000).allow(""),
  category: Joi.string().trim().min(1).max(100),
  brand: Joi.string().trim().max(100).allow("", null),
  priceCents: Joi.number().integer().min(0).max(100_000_000),
  currency: Joi.string().uppercase().length(3),
  imageUrl: Joi.string()
    .uri({ scheme: ["http", "https"] })
    .max(2048)
    .allow("", null),
  attributes: Joi.object()
    .pattern(/^[a-z][a-z0-9_]{0,49}$/, attributeValue)
    .max(50),
  isActive: Joi.boolean(),
})
  .min(1)
  .messages({ "object.min": "Provide at least one field to update." });

export const productIdParam = Joi.object({
  productId: Joi.string().uuid().required(),
}).unknown(true);

export const skuParam = Joi.object({
  sku: Joi.string()
    .trim()
    .uppercase()
    .pattern(/^[A-Z0-9-]{3,64}$/)
    .required(),
}).unknown(true);

export const bulkProductsSchema = Joi.object({
  productIds: Joi.array().items(Joi.string().uuid()).min(1).max(200).required(),
});

export const deleteProductQuerySchema = Joi.object({
  hard: Joi.boolean().default(false),
});

export const recordViewSchema = Joi.object({
  sessionId: Joi.string().max(128).allow("", null).default(null),
});
