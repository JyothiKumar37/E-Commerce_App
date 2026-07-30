import { Joi } from "@ecom/shared";

const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M}\-'. ]*$/u;

/**
 * Profile patch.
 *
 * Every field is optional and `min(1)` requires at least one of them. The old
 * route validated PUT /me against the full signup schema, where all five
 * fields were `required()` — so a user who wanted to change only their city
 * had to resubmit their password, and any partial update was rejected outright
 * even though the controller was written to handle one.
 */
export const updateProfileSchema = Joi.object({
  username: Joi.string().trim().alphanum().min(3).max(30).messages({
    "string.alphanum": "Username may contain only letters and numbers.",
  }),
  email: Joi.string()
    .lowercase()
    .trim()
    .email({ tlds: { allow: false } })
    .max(254),
  first_name: Joi.string().trim().min(1).max(100).pattern(NAME_PATTERN).messages({
    "string.pattern.base": "First name contains invalid characters.",
  }),
  last_name: Joi.string().trim().min(1).max(100).pattern(NAME_PATTERN).messages({
    "string.pattern.base": "Last name contains invalid characters.",
  }),
})
  .min(1)
  .messages({ "object.min": "Provide at least one field to update." });

/**
 * Password change is a separate endpoint requiring the current password.
 * Bundling it into the profile PUT (as the old code did) meant anyone holding
 * a stolen access token could change the password without proving they knew
 * the old one, locking the real owner out.
 */
export const changePasswordSchema = Joi.object({
  currentPassword: Joi.string().min(1).max(128).required().messages({
    "any.required": "Your current password is required.",
  }),
  newPassword: Joi.string()
    .min(10)
    .max(128)
    .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).+$/)
    .required()
    .messages({
      "string.min": "New password must be at least {#limit} characters long.",
      "string.pattern.base":
        "New password must contain an uppercase letter, a lowercase letter, a number and a symbol.",
    }),
});

export const deleteAccountSchema = Joi.object({
  password: Joi.string().min(1).max(128).required().messages({
    "any.required": "Your password is required to delete this account.",
  }),
});

const zipPattern = /^[0-9A-Za-z]+(?:[-\s][0-9A-Za-z]+)*$/;

export const addressSchema = Joi.object({
  address_type: Joi.string().valid("home", "work", "billing", "shipping", "other").default("home"),
  recipient_name: Joi.string().trim().min(1).max(200).required().messages({
    "any.required": "A recipient name is required.",
  }),
  address_line1: Joi.string().trim().min(1).max(255).required().messages({
    "any.required": "Address line 1 is required.",
  }),
  address_line2: Joi.string().trim().max(255).allow("", null).default(null),
  city: Joi.string().trim().min(1).max(100).required(),
  state: Joi.string().trim().max(100).allow("", null).default(null),
  country: Joi.string().trim().min(2).max(100).required(),
  zip: Joi.string().trim().max(20).pattern(zipPattern).required().messages({
    "string.pattern.base": "Postal code format is not valid.",
  }),
  phone: Joi.string().trim().max(30).allow("", null).default(null),
  is_default: Joi.boolean().default(false),
  effective_date: Joi.date()
    .iso()
    .default(() => new Date()),
});

/**
 * Same fields, but nothing is mandatory and — importantly — nothing has a
 * default. Forking `addressSchema` to optional would keep its `.default()`
 * calls, so a PATCH touching only `city` would silently also reset
 * `address_type` to "home" and `is_default` to false.
 */
export const addressPatchSchema = Joi.object({
  address_type: Joi.string().valid("home", "work", "billing", "shipping", "other"),
  recipient_name: Joi.string().trim().min(1).max(200),
  address_line1: Joi.string().trim().min(1).max(255),
  address_line2: Joi.string().trim().max(255).allow("", null),
  city: Joi.string().trim().min(1).max(100),
  state: Joi.string().trim().max(100).allow("", null),
  country: Joi.string().trim().min(2).max(100),
  zip: Joi.string().trim().max(20).pattern(zipPattern).messages({
    "string.pattern.base": "Postal code format is not valid.",
  }),
  phone: Joi.string().trim().max(30).allow("", null),
  is_default: Joi.boolean(),
  effective_date: Joi.date().iso(),
})
  .min(1)
  .messages({ "object.min": "Provide at least one field to update." });

/** Path-parameter guard shared by every address route. */
export const addressIdParam = Joi.object({
  addressId: Joi.string().uuid().required(),
}).unknown(true);
