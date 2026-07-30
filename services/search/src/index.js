import { checkConnection, start } from "@ecom/shared";
import { config } from "./config.js";
import { logger } from "./lib/logger.js";
import { pool } from "./lib/db.js";
import { ensureIndex } from "./lib/elastic.js";
import { startIndexer, stopIndexer } from "./services/indexer.js";
import { buildApp } from "./app.js";

await checkConnection(pool);

// Index setup is not fatal: the storefront can still serve the Postgres
// fallback path while Elasticsearch is coming up.
try {
  await ensureIndex();
} catch (err) {
  logger.error(
    { err: { message: err.message } },
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
