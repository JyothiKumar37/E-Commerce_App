#!/usr/bin/env node
/**
 * Minimal forward-only migration runner.
 *
 * Each .sql file in ./migrations runs once, inside a transaction, and is
 * recorded in schema_migrations with a checksum. If a file that has already
 * been applied is edited, the runner refuses to continue rather than silently
 * diverging environments.
 *
 *   node packages/database/migrate.js up      apply pending migrations
 *   node packages/database/migrate.js status  list applied / pending
 *   node packages/database/migrate.js down    DESTRUCTIVE: drop and recreate schema
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const ssl =
  (process.env.PGSSLMODE ?? "disable") === "disable"
    ? false
    : { rejectUnauthorized: process.env.PGSSLMODE !== "no-verify" };

async function connect() {
  const client = new Client({ connectionString: DATABASE_URL, ssl });
  await client.connect();
  return client;
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      duration_ms INTEGER NOT NULL
    )
  `);
}

async function loadMigrations() {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  return Promise.all(
    files.map(async (file) => {
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      return {
        version: file.replace(/\.sql$/, ""),
        sql,
        checksum: createHash("sha256").update(sql).digest("hex").slice(0, 16),
      };
    }),
  );
}

async function up() {
  const client = await connect();
  try {
    await ensureMigrationsTable(client);
    const migrations = await loadMigrations();
    const { rows: applied } = await client.query("SELECT version, checksum FROM schema_migrations");
    const appliedMap = new Map(applied.map((r) => [r.version, r.checksum]));

    let ran = 0;
    for (const migration of migrations) {
      const existingChecksum = appliedMap.get(migration.version);

      if (existingChecksum) {
        if (existingChecksum !== migration.checksum) {
          throw new Error(
            `Migration ${migration.version} has been modified after it was applied ` +
              `(recorded ${existingChecksum}, found ${migration.checksum}). ` +
              "Add a new migration instead of editing an applied one.",
          );
        }
        continue;
      }

      process.stdout.write(`  applying ${migration.version} ... `);
      const startedAt = Date.now();
      try {
        await client.query("BEGIN");
        await client.query(migration.sql);
        const durationMs = Date.now() - startedAt;
        await client.query(
          "INSERT INTO schema_migrations (version, checksum, duration_ms) VALUES ($1, $2, $3)",
          [migration.version, migration.checksum, durationMs],
        );
        await client.query("COMMIT");
        console.log(`done (${durationMs}ms)`);
        ran += 1;
      } catch (err) {
        await client.query("ROLLBACK");
        console.log("FAILED");
        throw err;
      }
    }

    console.log(ran === 0 ? "Database is up to date." : `Applied ${ran} migration(s).`);
  } finally {
    await client.end();
  }
}

async function status() {
  const client = await connect();
  try {
    await ensureMigrationsTable(client);
    const migrations = await loadMigrations();
    const { rows } = await client.query("SELECT version, applied_at FROM schema_migrations");
    const appliedMap = new Map(rows.map((r) => [r.version, r.applied_at]));

    for (const m of migrations) {
      const at = appliedMap.get(m.version);
      console.log(
        `${at ? "applied" : "pending"}  ${m.version}${at ? `  ${at.toISOString()}` : ""}`,
      );
    }
  } finally {
    await client.end();
  }
}

async function down() {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_DESTRUCTIVE !== "yes") {
    console.error(
      "Refusing to drop the schema in production. Set ALLOW_DESTRUCTIVE=yes to override.",
    );
    process.exit(1);
  }
  const client = await connect();
  try {
    console.log("Dropping and recreating the public schema...");
    await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    console.log("Schema reset. Run `npm run migrate` to rebuild.");
  } finally {
    await client.end();
  }
}

const command = process.argv[2] ?? "up";
const commands = { up, status, down };

if (!commands[command]) {
  console.error(`Unknown command: ${command}. Use one of: ${Object.keys(commands).join(", ")}`);
  process.exit(1);
}

commands[command]().catch((err) => {
  console.error(`\nMigration ${command} failed: ${err.message}`);
  process.exit(1);
});
