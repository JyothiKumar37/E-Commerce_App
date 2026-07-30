import { Router } from "express";
import { requireAuth, validate } from "@ecom/shared";
import { config } from "./config.js";
import {
  addressIdParam,
  addressPatchSchema,
  addressSchema,
  changePasswordSchema,
  deleteAccountSchema,
  updateProfileSchema,
} from "./schemas.js";
import { changePassword, deleteUser, getUser, updateUser } from "./controllers/userController.js";
import {
  createAddress,
  deleteAddress,
  getAddress,
  listAddresses,
  resolveAddressForOrder,
  setDefaultAddress,
  updateAddress,
} from "./controllers/addressController.js";

/**
 * Only tokens minted by the gateway for this hop are accepted. The audience is
 * `ecom:internal`, so a browser's own access token — even a valid one — cannot
 * reach this service directly if the network is ever misconfigured.
 */
const authenticate = requireAuth({ secret: config.INTERNAL_JWT_SECRET });

export function buildRouter() {
  const router = Router();
  router.use(authenticate);

  // --- profile --------------------------------------------------------
  router.get("/me", getUser);
  router.patch("/me", validate(updateProfileSchema), updateUser);
  router.post("/me/password", validate(changePasswordSchema), changePassword);
  router.delete("/me", validate(deleteAccountSchema), deleteUser);

  // --- address book ---------------------------------------------------
  router.get("/me/addresses", listAddresses);
  router.post("/me/addresses", validate(addressSchema), createAddress);
  router.get("/me/addresses/:addressId", validate(addressIdParam, "params"), getAddress);
  router.patch(
    "/me/addresses/:addressId",
    validate(addressIdParam, "params"),
    validate(addressPatchSchema),
    updateAddress,
  );
  router.post(
    "/me/addresses/:addressId/default",
    validate(addressIdParam, "params"),
    setDefaultAddress,
  );
  router.delete("/me/addresses/:addressId", validate(addressIdParam, "params"), deleteAddress);

  // --- service-to-service ---------------------------------------------
  // Consumed by place-order at checkout; never routed from the gateway.
  router.get(
    "/internal/addresses/:addressId",
    validate(addressIdParam, "params"),
    resolveAddressForOrder,
  );

  return router;
}
