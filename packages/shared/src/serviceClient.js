import axios from "axios";
import { AppError, ErrorCodes } from "./errors.js";
import { signInternalToken } from "./auth.js";
import { currentRequestId, REQUEST_ID_HEADER } from "./logger.js";

const IDEMPOTENT_METHODS = new Set(["get", "head", "options", "put", "delete"]);

/**
 * Typed HTTP client for calling another service.
 *
 * Every outbound request builds its header set from scratch — inbound client
 * headers are never forwarded. That closes the hole where the gateway relayed
 * the caller's `Authorization`, `host`, `content-length` and `cookie` headers
 * straight through to the upstream.
 */
export function createServiceClient({
  name,
  baseURL,
  internalSecret,
  timeout = 5_000,
  retries = 2,
  logger,
}) {
  const instance = axios.create({
    baseURL,
    timeout,
    // Do not let axios throw on 4xx; we translate statuses ourselves.
    validateStatus: () => true,
    maxRedirects: 0,
    headers: { "content-type": "application/json" },
  });

  async function request(
    method,
    path,
    {
      body,
      query,
      auth,
      headers = {},
      timeout: perCallTimeout,
      idempotencyKey,
      withResponse = false,
    } = {},
  ) {
    const outboundHeaders = {
      "content-type": "application/json",
      accept: "application/json",
      ...headers,
    };

    const requestId = currentRequestId();
    if (requestId) outboundHeaders[REQUEST_ID_HEADER] = requestId;
    if (idempotencyKey) outboundHeaders["idempotency-key"] = idempotencyKey;

    if (internalSecret) {
      outboundHeaders.authorization = `Bearer ${signInternalToken(
        { userId: auth?.userId, role: auth?.role, actor: process.env.SERVICE_NAME ?? "gateway" },
        { secret: internalSecret },
      )}`;
    }

    const maxAttempts = IDEMPOTENT_METHODS.has(method.toLowerCase()) ? retries + 1 : 1;
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await instance.request({
          method,
          url: path,
          data: body,
          params: query,
          headers: outboundHeaders,
          timeout: perCallTimeout ?? timeout,
        });

        if (response.status >= 500 && attempt < maxAttempts) {
          lastError = toUpstreamError(name, response);
          await backoff(attempt);
          continue;
        }
        if (response.status >= 400) throw toUpstreamError(name, response);

        // Callers doing service-to-service work want the payload; the gateway
        // proxy needs the status too, so it can relay 201/202/204 faithfully
        // instead of flattening everything to 200.
        return withResponse ? { status: response.status, data: response.data } : response.data;
      } catch (err) {
        if (err?.isAppError) throw err;

        const transient =
          err.code === "ECONNABORTED" ||
          err.code === "ECONNRESET" ||
          err.code === "ETIMEDOUT" ||
          err.code === "ECONNREFUSED" ||
          err.code === "EAI_AGAIN";

        lastError = toTransportError(name, err);
        logger?.warn(
          { service: name, method, path, attempt, code: err.code },
          "upstream request failed",
        );

        if (!transient || attempt === maxAttempts) throw lastError;
        await backoff(attempt);
      }
    }

    throw lastError ?? new AppError({ message: `Upstream ${name} failed`, statusCode: 502 });
  }

  return {
    name,
    baseURL,
    get: (path, opts) => request("get", path, opts),
    post: (path, opts) => request("post", path, opts),
    put: (path, opts) => request("put", path, opts),
    patch: (path, opts) => request("patch", path, opts),
    delete: (path, opts) => request("delete", path, opts),
    request,
    /** Like `request`, but resolves `{ status, data }` so a proxy can relay the
     *  upstream status code verbatim. */
    raw: (method, path, opts) => request(method, path, { ...opts, withResponse: true }),
    /** Liveness probe used by readiness aggregation. */
    async health() {
      const response = await instance.get("/healthz", { timeout: 2_000 });
      return response.status === 200;
    },
  };
}

function toUpstreamError(service, response) {
  const payload = response.data?.error ?? response.data ?? {};
  return new AppError({
    // Preserve the upstream's own message and code so the client sees the real
    // reason ("Insufficient stock") rather than a flattened "An error occurred".
    message: payload.message ?? `Upstream ${service} returned ${response.status}`,
    statusCode: response.status,
    errorType: payload.errorType,
    errorCode: payload.errorCode ?? ErrorCodes.UPSTREAM_ERROR,
    details: payload.details,
    expose: response.status < 500,
  });
}

function toTransportError(service, err) {
  if (err.code === "ECONNABORTED" || /timeout/i.test(err.message ?? "")) {
    return new AppError({
      message: `Upstream ${service} timed out`,
      statusCode: 504,
      errorCode: ErrorCodes.UPSTREAM_TIMEOUT,
      cause: err,
    });
  }
  return new AppError({
    message: `Upstream ${service} is unavailable`,
    statusCode: 503,
    errorCode: ErrorCodes.UPSTREAM_ERROR,
    cause: err,
  });
}

const backoff = (attempt) =>
  new Promise((resolve) => setTimeout(resolve, 2 ** (attempt - 1) * 100 + Math.random() * 50));
