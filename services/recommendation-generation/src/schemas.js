import { Joi } from "@ecom/shared";

export const startRunSchema = Joi.object({
  strategy: Joi.string().max(50).default("co_occurrence_v1"),
  /** When true the request blocks until the batch finishes; useful in CI. */
  wait: Joi.boolean().default(false),
});

export const runIdParam = Joi.object({
  runId: Joi.string().uuid().required(),
}).unknown(true);
