/**
 * In-process Postgres test harness backed by `@electric-sql/pglite`.
 *
 * - `setupTestDb()` boots a PGlite instance with the full schema applied and
 *   returns a drizzle handle plus the raw client.
 * - `seedOrg() / seedUser() / seedAgent() / seedContact()` insert the
 *   minimum-viable rows needed for integration tests against the API.
 * - `teardownTestDb()` closes the PGlite handle.
 *
 * ## Migration snapshot (why this file is not just "replay 16 SQL files")
 *
 * Replaying every drizzle migration against a fresh pglite costs ~3s of
 * single-threaded work. With `pnpm test` fanning ~35 integration files out
 * across forked workers, CPU is heavily oversubscribed and that 3s job can
 * stretch past the 30s `beforeAll` hook timeout — flakily, on whichever
 * files happened to lose the CPU lottery.
 *
 * The fix removes the cost rather than masking it: we replay the migrations
 * exactly ONCE, `dumpDataDir()` the resulting database to an (uncompressed)
 * tarball, and every subsequent `setupTestDb()` boots a fresh pglite by
 * `loadDataDir`-ing that snapshot. A restore is ~0.5s vs ~3s for a replay,
 * and — crucially — it is a bulk in-memory load rather than 200+ tiny
 * `exec()` round-trips, so it degrades far more gracefully under contention.
 *
 * The snapshot is built lazily on first use and cached two ways:
 *   1. In-process, via a module-level promise (one build per worker at most).
 *   2. On disk, in the OS temp dir keyed by a hash of the migration files,
 *      so sibling workers reuse the first worker's build instead of each
 *      paying the ~3s replay. The file is written atomically (write to a
 *      unique temp name, then `rename`) so a half-written snapshot is never
 *      observed.
 *
 * We intentionally keep this file dependency-free of `@workspace/db`'s `db`
 * export so the vi.mock factories that wire it in can import it without
 * circularity. We DO import the schema definitions, since those don't
 * touch the Postgres pool.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@workspace/db/schema";
import { encryptMedicareId } from "@workspace/db/encryption/medicareId";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

export interface TestDbHandle {
  db: TestDb;
  pg: PGlite;
}

const MIGRATIONS_DIR = path.resolve(
  __dirname,
  "../../../../../lib/db/migrations",
);

function loadMigrationSql(): string[] {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && !f.endsWith("_down.sql"))
    .sort();
  return files.map((f) =>
    fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"),
  );
}

/**
 * Split a drizzle-generated migration script into individual statements at
 * the `--> statement-breakpoint` marker. The marker exists because pg-core
 * emits multi-statement files but drivers vary on whether they accept them
 * in a single `exec()` call. PGlite executes statement-by-statement most
 * reliably.
 */
function splitStatements(sql: string): string[] {
  return sql
    .split(/-->\s*statement-breakpoint/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Replay every migration against a fresh pglite. This is the slow path —
 * only the snapshot builder calls it, exactly once per migration revision.
 */
async function migrateFresh(pg: PGlite): Promise<void> {
  for (const sql of loadMigrationSql()) {
    for (const stmt of splitStatements(sql)) {
      try {
        await pg.exec(stmt);
      } catch (err) {
        const preview = stmt.slice(0, 200).replace(/\s+/g, " ");
        throw new Error(
          `pglite migration failure on statement: ${preview}\n  caused by: ${(err as Error).message}`,
        );
      }
    }
  }
}

/**
 * Content hash of all migration files — used to key the on-disk snapshot so
 * a stale snapshot is never reused after a migration is added or edited.
 */
function migrationsRevision(): string {
  const h = createHash("sha256");
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && !f.endsWith("_down.sql"))
    .sort();
  for (const f of files) {
    h.update(f);
    h.update(fs.readFileSync(path.join(MIGRATIONS_DIR, f)));
  }
  return h.digest("hex").slice(0, 16);
}

// In-process cache: at most one snapshot build per worker, even if many
// test files in the same worker call setupTestDb(). The snapshot is held as
// an ArrayBuffer so each boot can wrap it in a fresh Blob without copying.
let snapshotPromise: Promise<ArrayBuffer> | undefined;

function snapshotPath(): string {
  return path.join(
    os.tmpdir(),
    `mediflow-pglite-snapshot-${migrationsRevision()}.tar`,
  );
}

/**
 * Build (or load) the migrated-database snapshot. The result is a tarball
 * produced by `pglite.dumpDataDir("none")` — uncompressed, because the
 * tarball is short-lived in the OS temp dir and skipping gzip makes both
 * the dump and every subsequent restore meaningfully faster.
 */
async function getMigrationSnapshot(): Promise<ArrayBuffer> {
  if (snapshotPromise) return snapshotPromise;
  snapshotPromise = (async (): Promise<ArrayBuffer> => {
    const file = snapshotPath();

    // Fast path: a sibling worker already built it.
    try {
      const cached = fs.readFileSync(file);
      return cached.buffer.slice(
        cached.byteOffset,
        cached.byteOffset + cached.byteLength,
      );
    } catch {
      // Not there yet — fall through and build it ourselves.
    }

    const pg = new PGlite();
    await pg.query("SELECT 1"); // wait for ready
    await migrateFresh(pg);
    const dump = await pg.dumpDataDir("none");
    await pg.close();
    const bytes = await dump.arrayBuffer();

    // Atomic publish: write to a unique temp name then rename into place so
    // no worker ever reads a half-written snapshot. A losing race just
    // overwrites with byte-identical content, which is harmless.
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, Buffer.from(bytes));
      fs.renameSync(tmp, file);
    } catch {
      // Disk caching is best-effort; an in-process cache still applies.
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
    return bytes;
  })();
  return snapshotPromise;
}

export async function setupTestDb(): Promise<TestDbHandle> {
  const snapshot = await getMigrationSnapshot();
  // `loadDataDir` wants a Blob/File; wrap the cached bytes (a fresh Blob per
  // boot so concurrent boots don't share a consumed stream).
  const pg = new PGlite({ loadDataDir: new Blob([snapshot]) });
  await pg.query("SELECT 1"); // wait for ready

  const db = drizzle(pg, { schema });
  return { db, pg };
}

export async function teardownTestDb(handle: TestDbHandle): Promise<void> {
  await handle.pg.close();
}

// ---- Seed helpers -----------------------------------------------------------

export interface SeedOrgOptions {
  id?: string;
  name?: string;
  slug?: string;
}

export async function seedOrg(
  db: TestDb,
  opts: SeedOrgOptions = {},
): Promise<{ id: string; name: string; slug: string }> {
  const id = opts.id ?? `org-${randomUUID()}`;
  const name = opts.name ?? "Test Org";
  const slug = opts.slug ?? `test-${id.slice(-8)}`;
  await db.insert(schema.organizationsTable).values({ id, name, slug });
  return { id, name, slug };
}

export interface SeedUserOptions {
  id?: string;
  orgId: string;
  email?: string;
  fullName?: string;
  role?: schema.User["role"];
  isActive?: boolean;
}

export async function seedUser(
  db: TestDb,
  opts: SeedUserOptions,
): Promise<{ id: string; orgId: string; role: schema.User["role"] }> {
  const id = opts.id ?? `user-${randomUUID()}`;
  const role = opts.role ?? "agent";
  await db.insert(schema.usersTable).values({
    id,
    orgId: opts.orgId,
    email: opts.email ?? `${id}@example.com`,
    fullName: opts.fullName ?? "Test User",
    role,
    isActive: opts.isActive ?? true,
  });
  return { id, orgId: opts.orgId, role };
}

export interface SeedAgentOptions {
  id?: string;
  orgId: string;
  firstName?: string;
  lastName?: string;
  email?: string;
}

export async function seedAgent(
  db: TestDb,
  opts: SeedAgentOptions,
): Promise<{ id: string; orgId: string }> {
  const id = opts.id ?? `agent-${randomUUID()}`;
  await db.insert(schema.agentsTable).values({
    id,
    orgId: opts.orgId,
    firstName: opts.firstName ?? "Agent",
    lastName: opts.lastName ?? "Smith",
    email: opts.email ?? `${id}@agency.example`,
  });
  return { id, orgId: opts.orgId };
}

export interface SeedContactOptions {
  id?: string;
  orgId: string;
  firstName?: string;
  lastName?: string;
  dob?: Date | null;
  medicareId?: string | null;
  healthConditions?: string[] | null;
  status?: schema.Contact["status"];
  leadSource?: string | null;
  email?: string | null;
}

export async function seedContact(
  db: TestDb,
  opts: SeedContactOptions,
): Promise<schema.Contact & { medicareId: string | null }> {
  const id = opts.id ?? `contact-${randomUUID()}`;
  // HIPAA-2: the plaintext `medicare_id` column was dropped in migration
  // 0017. We store the MBI ONLY as AES-256-GCM ciphertext + HMAC blind
  // index — exactly what production does on every write.
  const enc = opts.medicareId ? encryptMedicareId(opts.medicareId) : null;
  const [row] = await db
    .insert(schema.contactsTable)
    .values({
      id,
      orgId: opts.orgId,
      firstName: opts.firstName ?? "Jane",
      lastName: opts.lastName ?? "Doe",
      email: opts.email ?? null,
      dob: opts.dob ?? null,
      medicareIdEncrypted: enc?.encrypted ?? null,
      medicareIdHash: enc?.hash ?? null,
      healthConditions: opts.healthConditions ?? null,
      status: opts.status ?? "lead",
      leadSource: opts.leadSource ?? null,
    })
    .returning();
  // Echo back the plaintext MBI the caller supplied as a convenience
  // (it is NOT a database column). Tests that need to feed the same MBI
  // into a commission line item / search query read it from here instead
  // of selecting a column that no longer exists.
  return { ...row, medicareId: opts.medicareId ?? null };
}

export async function seedAutomationRule(
  db: TestDb,
  opts: {
    orgId: string;
    name?: string;
    triggerType: string;
    conditions?: unknown;
    actions?: unknown;
    isActive?: boolean;
  },
): Promise<{ id: string }> {
  const id = `rule-${randomUUID()}`;
  await db.insert(schema.automationRulesTable).values({
    id,
    orgId: opts.orgId,
    name: opts.name ?? "Test rule",
    triggerType: opts.triggerType,
    conditions: opts.conditions ?? null,
    actions: opts.actions ?? null,
    isActive: opts.isActive ?? true,
  });
  return { id };
}
