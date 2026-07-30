import { createClient } from "redis";
import { AppError } from "./errors.js";

/**
 * Redis client with bounded reconnection. Used for carts (with TTL) and as the
 * shared store for rate limiting so limits hold across gateway replicas.
 */
export function createRedisClient({ url, logger, name = "redis" } = {}) {
  const client = createClient({
    url,
    socket: {
      connectTimeout: 5_000,
      reconnectStrategy: (retries) => {
        if (retries > 20) return new Error("Redis reconnection limit reached");
        return Math.min(retries * 100, 3_000);
      },
    },
  });

  client.on("error", (err) => {
    logger?.error({ err: { message: err.message }, name }, "redis client error");
  });
  client.on("reconnecting", () => logger?.warn({ name }, "redis reconnecting"));
  client.on("ready", () => logger?.info({ name }, "redis ready"));

  return client;
}

export async function checkRedis(client) {
  try {
    const pong = await client.ping();
    if (pong !== "PONG") throw new Error(`unexpected ping reply: ${pong}`);
    return true;
  } catch (err) {
    throw new AppError({
      message: "Cache unavailable",
      statusCode: 503,
      errorCode: "REDIS_UNAVAILABLE",
      cause: err,
    });
  }
}

/** JSON get/set helpers so callers do not hand-roll parse/stringify. */
export async function getJson(client, key) {
  const raw = await client.get(key);
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    await client.del(key); // poison entry, drop it
    return null;
  }
}

export async function setJson(client, key, value, { ttlSeconds } = {}) {
  const payload = JSON.stringify(value);
  if (ttlSeconds) return client.set(key, payload, { EX: ttlSeconds });
  return client.set(key, payload);
}
