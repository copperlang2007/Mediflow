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

/**
 * Indexes a migration file creates with a plain (write-blocking)
 * `CREATE INDEX IF NOT EXISTS`, because the migrator wraps each file in a
 * transaction and CONCURRENTLY cannot run inside one. Before migrating, the
 * runner builds each one CONCURRENTLY on an existing table, so the migration's
 * own statement is a no-op and never holds a write lock on a live table (a
 * blocked write would stall the Twilio STOP webhook). On a fresh database the
 * table does not exist yet and the migration builds the index as usual.
 * Each `definition` must match its migration file exactly.
 */
const CONCURRENT_PREBUILDS: ReadonlyArray<{ name: string; table: string; definition: string }> = [
  {
    name: "contacts_phone_last10_idx",
    table: "contacts",
    definition: "((right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10)))",
  },
  {
    name: "opt_outs_phone_last10_channel_idx",
    table: "opt_outs",
    definition: "((right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10)), channel)",
  },
  // 0061: contact de-duplication lookups (loadMatcher).
  {
    name: "contacts_org_lower_email_idx",
    table: "contacts",
    definition: "(org_id, lower(email)) WHERE email IS NOT NULL",
  },
  {
    name: "contacts_org_lower_last_name_idx",
    table: "contacts",
    definition: "(org_id, lower(last_name))",
  },
  {
    name: "contacts_org_medicare_id_hash_idx",
    table: "contacts",
    definition: "(org_id, medicare_id_hash) WHERE medicare_id_hash IS NOT NULL",
  },
];

async function prebuildIndexesConcurrently(client: pg.Client): Promise<void> {
  for (const idx of CONCURRENT_PREBUILDS) {
    const table = await client.query("SELECT to_regclass($1) AS oid", [`public.${idx.table}`]);
    if (!table.rows[0]?.oid) continue;
    const existing = await client.query(
      `SELECT i.indisvalid AS valid
         FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
        WHERE c.relname = $1 AND c.relnamespace = 'public'::regnamespace`,
      [idx.name],
    );
    if (existing.rows[0]?.valid) continue;
    // A failed earlier CONCURRENTLY build leaves an INVALID index that
    // IF NOT EXISTS would silently keep — drop it and rebuild.
    if (existing.rows.length > 0) {
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS public.${idx.name}`);
    }
    console.log(`[migrate] building ${idx.name} concurrently`);
    await client.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${idx.name} ON public.${idx.table} ${idx.definition}`,
    );
  }
}

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
    await prebuildIndexesConcurrently(client);
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
