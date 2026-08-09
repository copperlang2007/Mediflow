/**
 * Serialized migration runner.
 *
 * drizzle's migrator creates the `__drizzle_migrations` bookkeeping table
 * OUTSIDE its transaction wrapper and takes no lock, so two overlapping
 * boots on a fresh database race and the loser dies with pg 42P07
 * ("pg_type_typname_nsp_index"). A session-scoped advisory lock held on a
 * dedicated connection serializes concurrent runners: peers block until the
 * winner finishes, then find the journal already applied and no-op.
 *
 * Matches drizzle.config.ts exactly (folder ./migrations, table
 * __drizzle_migrations, schema public) so it replays the same journal the
 * `migrate:cli` drizzle-kit path uses.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

// Arbitrary app-wide constant; every migration runner must use the same key.
const MIGRATION_LOCK_KEY = 981_234_501;

const here = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    const db = drizzle(client);
    await migrate(db, {
      migrationsFolder: path.join(here, "../migrations"),
      migrationsTable: "__drizzle_migrations",
      migrationsSchema: "public",
    });
    console.log("[migrate] migrations applied");
  } finally {
    await client
      .query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY])
      .catch(() => {
        /* connection teardown releases session locks anyway */
      });
    await client.end();
  }
}

main().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
