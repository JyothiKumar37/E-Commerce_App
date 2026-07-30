import { Router } from "express";
import { requireAuth, requireRole, validate } from "@ecom/shared";
import { config } from "./config.js";
import { runIdParam, startRunSchema } from "./schemas.js";
import { getRun, getStats, listRuns, startRun } from "./controllers/runController.js";

// Every endpoint here is operator-facing; none is exposed to customers.
const adminOnly = [requireAuth({ secret: config.INTERNAL_JWT_SECRET }), requireRole("admin")];

export function buildRouter() {
  const router = Router();
  router.use(...adminOnly);

  router.post("/runs", validate(startRunSchema), startRun);
  router.get("/runs", listRuns);
  router.get("/runs/:runId", validate(runIdParam, "params"), getRun);
  router.get("/stats", getStats);

  return router;
}
