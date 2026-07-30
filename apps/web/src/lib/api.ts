/**
 * API client.
 *
 * Token strategy:
 *   - the access token lives in a module-scoped variable, never localStorage,
 *     so an XSS payload cannot read it out of persistent storage
 *   - the refresh token is an httpOnly cookie the JS never sees at all
 *   - a 401 triggers one silent refresh, and every request that raced the
 *     expiry waits on that single refresh rather than stampeding the endpoint
 */

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8080";

let accessToken: string | null = null;
let refreshPromise: Promise<string | null> | null = null;
let onAuthLost: (() => void) | null = null;

export const setAccessToken = (token: string | null) => {
  accessToken = token;
};
export const getAccessToken = () => accessToken;
export const setAuthLostHandler = (handler: (() => void) | null) => {
  onAuthLost = handler;
};

export interface ApiErrorPayload {
  message: string;
  errorType?: string;
  errorCode?: string;
  statusCode: number;
  details?: { field: string; message: string }[] | Record<string, unknown>;
  requestId?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: ApiErrorPayload["details"];
  readonly requestId?: string;

  constructor(payload: ApiErrorPayload) {
    super(payload.message);
    this.name = "ApiError";
    this.status = payload.statusCode;
    this.code = payload.errorCode ?? "UNKNOWN";
    this.details = payload.details;
    this.requestId = payload.requestId;
  }

  /** Field-level messages, for rendering next to the offending input. */
  get fieldErrors(): Record<string, string> {
    if (!Array.isArray(this.details)) return {};
    return Object.fromEntries(this.details.map((d) => [d.field, d.message]));
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null | string[]>;
  idempotencyKey?: string;
  /** Internal: prevents a refresh loop when the refresh call itself 401s. */
  skipRefresh?: boolean;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: RequestOptions["query"]): string {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, API_URL);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      if (Array.isArray(value)) value.forEach((v) => url.searchParams.append(key, String(v)));
      else url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/**
 * Exchanges the refresh cookie for a new access token. Concurrent callers
 * share one in-flight request.
 */
async function refreshAccessToken(): Promise<string | null> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const response = await fetch(buildUrl("/auth/refresh"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
      });

      if (!response.ok) {
        accessToken = null;
        onAuthLost?.();
        return null;
      }

      const data = (await response.json()) as { accessToken: string };
      accessToken = data.accessToken;
      return data.accessToken;
    } catch {
      accessToken = null;
      onAuthLost?.();
      return null;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, query, idempotencyKey, skipRefresh, signal } = options;

  const send = async (token: string | null): Promise<Response> => {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;

    return fetch(buildUrl(path, query), {
      method,
      headers,
      // Needed for the refresh cookie; the gateway's CORS allowlist permits it.
      credentials: "include",
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  };

  let response = await send(accessToken);

  // One retry after a silent refresh. `skipRefresh` guards the refresh call
  // itself so a dead session cannot recurse.
  if (response.status === 401 && !skipRefresh) {
    const fresh = await refreshAccessToken();
    if (fresh) response = await send(fresh);
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const data = text ? safeParse(text) : null;

  if (!response.ok) {
    const payload = (data as { error?: ApiErrorPayload } | null)?.error;
    throw new ApiError(
      payload ?? {
        message: response.statusText || "Request failed",
        statusCode: response.status,
      },
    );
  }

  return data as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, "method" | "body">) =>
    request<T>(path, { ...options, method: "GET" }),
  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, "method" | "body">) =>
    request<T>(path, { ...options, method: "POST", body }),
  patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, "method" | "body">) =>
    request<T>(path, { ...options, method: "PATCH", body }),
  put: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, "method" | "body">) =>
    request<T>(path, { ...options, method: "PUT", body }),
  delete: <T>(path: string, options?: Omit<RequestOptions, "method" | "body">) =>
    request<T>(path, { ...options, method: "DELETE" }),
  refresh: refreshAccessToken,
};

/** RFC 4122 v4, used for Idempotency-Key on checkout. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `key-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}
