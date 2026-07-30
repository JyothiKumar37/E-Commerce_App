import { Joi } from "@ecom/shared";

/**
 * Names may contain letters from any script plus spaces, hyphens and
 * apostrophes. The old pattern enumerated a fixed list of Latin-1 accented
 * characters, which silently rejected names written in Cyrillic, Greek, Arabic
 * or any CJK script. `\p{L}` with the `u` flag covers all of them.
 */
const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M}\-'. ]*$/u;

/**
 * At least one lowercase, one uppercase, one digit and one symbol.
 *
 * The original character class was `[A-Za-z\d@$!%*?&]+`, which *rejected* any
 * password containing a character outside that set — so `Password123#` failed
 * validation despite being strong. Length is checked separately so the message
 * says which rule was broken.
 */
const PASSWORD_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).+$/;

export const passwordField = Joi.string()
  .min(10)
  .max(128)
  .pattern(PASSWORD_PATTERN)
  .required()
  .messages({
    "string.min": "Password must be at least {#limit} characters long.",
    "string.max": "Password must be at most {#limit} characters long.",
    "string.pattern.base":
      "Password must contain an uppercase letter, a lowercase letter, a number and a symbol.",
    "string.empty": "Password is required.",
    "any.required": "Password is required.",
  });

export const emailField = Joi.string()
  .lowercase()
  .trim()
  // The old schema allowed only .com/.net/.de, rejecting .org, .io, .co.uk and
  // every country TLD. Any registered TLD of two or more characters is valid.
  .email({ minDomainSegments: 2, tlds: { allow: false } })
  .max(254)
  .required()
  .messages({
    "string.email": "Please enter a valid email address.",
    "string.empty": "Email is required.",
    "any.required": "Email is required.",
  });

export const usernameField = Joi.string().trim().alphanum().min(3).max(30).required().messages({
  "string.alphanum": "Username may contain only letters and numbers.",
  "string.min": "Username must be at least {#limit} characters long.",
  "string.max": "Username must be at most {#limit} characters long.",
  "any.required": "Username is required.",
});

export const nameField = (label) =>
  Joi.string()
    .trim()
    .min(1)
    .max(100)
    .pattern(NAME_PATTERN)
    .required()
    .messages({
      "string.max": `${label} must be at most {#limit} characters long.`,
      "string.pattern.base": `${label} contains invalid characters.`,
      "any.required": `${label} is required.`,
    });

export const signUpSchema = Joi.object({
  username: usernameField,
  email: emailField,
  password: passwordField,
  first_name: nameField("First name"),
  last_name: nameField("Last name"),
});

/**
 * Sign-in is validated too. The original `signIn` had no validation at all, so
 * a non-string password reached `bcrypt.compare` and threw a 500 instead of a
 * clean 400.
 */
export const signInSchema = Joi.object({
  email: Joi.string()
    .lowercase()
    .trim()
    .email({ tlds: { allow: false } })
    .required()
    .messages({
      "string.email": "Please enter a valid email address.",
      "any.required": "Email is required.",
    }),
  password: Joi.string().min(1).max(128).required().messages({
    "any.required": "Password is required.",
  }),
});
