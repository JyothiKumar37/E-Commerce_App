import { checkConnection, start } from "@ecom/shared";
import { config } from "./config.js";
import { logger } from "./lib/logger.js";
import { pool } from "./lib/db.js";
import { ensureIndex } from "./lib/elastic.js";
import { reindexAll, startIndexer, stopIndexer } from "./services/indexer.js";
import { buildApp } from "./app.js";

await checkConnection(pool);

// Index setup is not fatal: the storefront can still serve the Postgres
// fallback path while Elasticsearch is coming up.
//
// `reindex` is passed in rather than imported by lib/elastic.js, which knows
// nothing about Postgres. When the live mapping is out of date, ensureIndex
// builds the replacement, calls this to fill it from the catalogue, and only
// then moves the alias — so an upgrade costs staleness rather than downtime.
try {
  const result = await ensureIndex({
    reindex: (target) => reindexAll({ index: target }),
  });
  if (result.rebuilt) {
    logger.info({ index: result.index }, "search index rebuilt for the current mapping");
  }
} catch (err) {
  logger.error(
    { err: { message: err.message, type: err?.meta?.body?.error?.type } },
    "could not prepare elasticsearch index; search will run in degraded mode",
  );
}

// Drains catalog_outbox into Elasticsearch.
startIndexer();

start({
  app: buildApp(),
  port: config.PORT,
  serviceName: config.SERVICE_NAME,
  logger,
  onShutdown: [async () => stopIndexer(), () => pool.end()],
});
