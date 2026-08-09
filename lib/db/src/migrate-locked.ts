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

// Bounded acquisition: a blocking pg_advisory_lock would wait FOREVER on a
// peer session that never releases (crashed-but-undetected pod, network
// partition, pooler holding the session open) — and since startCommand
// refuses to boot until migrate exits, the container would hang instead of
// crash-restarting. try-lock + retry keeps the normal contended path (peer
// finishes in seconds, we acquire on a retry) while capping the pathological
// one: on timeout we exit 1 and Render's restart loop retries with a fresh
// session.
// The 60s ceiling is a RETRY CADENCE, not a hard limit on migration length:
// a peer legitimately migrating for >60s makes the loser exit 1, Render
// restarts it, and each restart re-attempts — the loop converges as soon as
// the winner finishes. (Current journal completes in ~1.4s; revisit only if
// a migration set approaches the ceiling AND the restart churn matters.)
const LOCK_TIMEOUT_MS = 60_000;
const LOCK_RETRY_MS = 500;

const here = path.dirname(fileURLToPath(import.meta.url));

async function acquireLock(client: pg.Client): Promise<void> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    const res = await client.query(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [MIGRATION_LOCK_KEY],
    );
    if (res.rows[0]?.locked) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `migration lock not acquired within ${LOCK_TIMEOUT_MS}ms — ` +
          "a peer migration runner is stuck holding it",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await acquireLock(client);
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
