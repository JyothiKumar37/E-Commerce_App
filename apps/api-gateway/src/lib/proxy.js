import { asyncHandler, createServiceClient } from "@ecom/shared";
import { config } from "../config.js";
import { logger } from "./logger.js";

/**
 * Builds a reverse-proxy handler for one downstream service.
 *
 * Differences from the original implementation, all of which were bugs:
 *
 *  1. The outbound header set is *constructed*, never copied from the inbound
 *     request. The old code passed `headers: req.headers` wholesale and then
 *     tried to remove the credential with `delete headers["Authorization"]` —
 *     which never matched, because Node lowercases inbound header names. It
 *     also forwarded `host` and `content-length`, the latter of which is wrong
 *     as soon as the body is re-serialised.
 *  2. The caller's identity travels as a freshly minted, 60-second internal
 *     token rather than the user's own long-lived JWT.
 *  3. Upstream error messages and codes survive the hop instead of collapsing
 *     into a generic "An error occurred" / API_001.
 */
export function createProxy({ name, baseURL, timeout = config.UPSTREAM_TIMEOUT_MS }) {
  const client = createServiceClient({
    name,
    baseURL,
    internalSecret: config.INTERNAL_JWT_SECRET,
    timeout,
    retries: 2,
    logger,
  });

  const handler = asyncHandler(async (req, res) => {
    // `req.path`, not `req.url`: inside a mounted handler `req.url` still
    // carries the query string, which axios would then append a second time
    // from `params`, producing `?q=x&q=x`.
    const { status, data } = await client.raw(req.method, req.path, {
      body: hasBody(req) ? req.body : undefined,
      query: req.query,
      auth: req.auth ? { userId: req.auth.userId, role: req.auth.role } : undefined,
      headers: forwardableHeaders(req),
      idempotencyKey: req.headers["idempotency-key"],
    });

    // 204 carries no body; sending one is a protocol violation some clients
    // reject outright.
    if (status === 204 || data === undefined || data === null || data === "") {
      return res.status(204).end();
    }

    // Relay the upstream status verbatim. Falling through to `res.json(data)`
    // would rewrite every 201 Created and 202 Accepted as a 200, so a client
    // could not tell "created" from "already existed".
    return res.status(status).json(data);
  });

  handler.client = client;
  return handler;
}

/**
 * The narrow allowlist of inbound headers worth relaying. Everything else —
 * authorization, cookie, host, content-length, connection — is dropped.
 */
function forwardableHeaders(req) {
  const headers = {};
  if (req.headers["accept-language"]) headers["accept-language"] = req.headers["accept-language"];
  if (req.headers["user-agent"]) headers["x-forwarded-user-agent"] = req.headers["user-agent"];
  headers["x-forwarded-for"] = req.ip;
  return headers;
}

/**
 * DELETE is included: `DELETE /account/me` carries the user's password as
 * confirmation, and dropping the body here would make it fail validation
 * upstream with a confusing "body must not be empty".
 */
const hasBody = (req) => !["GET", "HEAD"].includes(req.method.toUpperCase());
