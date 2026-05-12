/**
 * Dev console — read-only schema browser.
 *
 * All routes here are introspection-only. There is no raw query endpoint,
 * and no INSERT/UPDATE/DELETE/DROP is ever issued. Table-name params are
 * validated against the live information_schema before being interpolated
 * into a pg_indexes lookup, so they cannot be used to inject SQL.
 *
 * Performance note: pg_class.reltuples is an *approximate* row count
 * maintained by ANALYZE. We use it (rather than count(*)) because on a
 * large db a real count would scan every table. The approximation can be
 * -1 for never-analyzed tables; we coerce that to null.
 *
 * We also LIMIT 500 on the table list as a belt-and-suspenders defense
 * against pathologically large schemas.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { requireAuth, requirePermission } from "../../middlewares/requireAuth";
import { requireMfa } from "../../middlewares/requireMfa";

const router: IRouter = Router();

// Match the pattern set by /dev/ops: even with the env-var gate open,
// the caller must be authenticated, hold dev_console:read, AND have MFA
// enrolled (HIPAA technical safeguard for privileged dev surfaces).
router.use(requireAuth, requireMfa, requirePermission("dev_console", "read"));

type PgRow = Record<string, unknown>;
type PgResult = { rows?: PgRow[] };

function rowsOf(result: unknown): PgRow[] {
  return (result as PgResult).rows ?? [];
}

// ---------------------------------------------------------------------------
// GET /dev/db/tables
// ---------------------------------------------------------------------------
router.get("/db/tables", async (_req: Request, res: Response) => {
  try {
    // Left join pg_class on the unqualified table name within the public
    // namespace. reltuples is a real (float4) so we cast to bigint via
    // floor() and then to int for a JSON-friendly number. -1 means "never
    // analyzed"; we map it to null on the client side.
    const result = await db.execute(sql`
      SELECT
        t.table_name AS name,
        CASE
          WHEN c.reltuples IS NULL OR c.reltuples < 0 THEN NULL
          ELSE floor(c.reltuples)::bigint
        END AS row_count
      FROM information_schema.tables t
      LEFT JOIN pg_namespace n ON n.nspname = t.table_schema
      LEFT JOIN pg_class c ON c.relname = t.table_name AND c.relnamespace = n.oid
      WHERE t.table_schema = 'public'
        AND t.table_type = 'BASE TABLE'
      ORDER BY t.table_name
      LIMIT 500
    `);

    const tables = rowsOf(result).map((r) => ({
      name: String(r.name),
      rowCount:
        r.row_count === null || r.row_count === undefined
          ? null
          : Number(r.row_count),
    }));
    res.json(tables);
  } catch (err) {
    res.status(500).json({
      error: "Failed to list tables",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

// Cache of validated table names. Refresh on each :name lookup is cheap
// because information_schema is in shared catalog memory.
async function listPublicTableNames(): Promise<Set<string>> {
  const result = await db.execute(sql`
    SELECT table_name AS name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    LIMIT 500
  `);
  return new Set(rowsOf(result).map((r) => String(r.name)));
}

// ---------------------------------------------------------------------------
// GET /dev/db/tables/:name/columns
// ---------------------------------------------------------------------------
router.get("/db/tables/:name/columns", async (req: Request, res: Response) => {
  const rawName = req.params.name;
  const name = Array.isArray(rawName) ? (rawName[0] ?? "") : (rawName ?? "");
  // Defense in depth: fast-fail on obviously-malicious input before we even
  // hit the db. Real validation is the allowlist check below.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    res.status(400).json({ error: "Invalid table name" });
    return;
  }

  try {
    const known = await listPublicTableNames();
    if (!known.has(name)) {
      res.status(404).json({ error: "Table not found" });
      return;
    }

    const result = await db.execute(sql`
      SELECT
        column_name AS name,
        data_type AS type,
        is_nullable AS nullable,
        column_default AS "default"
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${name}
      ORDER BY ordinal_position
    `);

    const cols = rowsOf(result).map((r) => ({
      name: String(r.name),
      type: String(r.type),
      nullable: r.nullable === "YES",
      default: r.default === null || r.default === undefined ? null : String(r.default),
    }));
    res.json(cols);
  } catch (err) {
    res.status(500).json({
      error: "Failed to list columns",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

// ---------------------------------------------------------------------------
// GET /dev/db/tables/:name/indexes
// ---------------------------------------------------------------------------
router.get("/db/tables/:name/indexes", async (req: Request, res: Response) => {
  const rawName = req.params.name;
  const name = Array.isArray(rawName) ? (rawName[0] ?? "") : (rawName ?? "");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    res.status(400).json({ error: "Invalid table name" });
    return;
  }

  try {
    const known = await listPublicTableNames();
    if (!known.has(name)) {
      res.status(404).json({ error: "Table not found" });
      return;
    }

    // pg_indexes gives us indexname + indexdef. We parse the column list
    // and uniqueness out of the indexdef string because pulling them from
    // pg_index/pg_attribute is more code without much more accuracy here.
    const result = await db.execute(sql`
      SELECT indexname AS name, indexdef AS def
      FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = ${name}
      ORDER BY indexname
    `);

    const indexes = rowsOf(result).map((r) => {
      const def = String(r.def);
      const unique = /CREATE\s+UNIQUE\s+INDEX/i.test(def);
      // CREATE [UNIQUE] INDEX name ON schema.table USING method (col1, col2, ...)
      const match = def.match(/\(([^)]*)\)/);
      const columns = match
        ? match[1].split(",").map((c) => c.trim().replace(/\s+(ASC|DESC).*$/i, ""))
        : [];
      return {
        name: String(r.name),
        columns,
        unique,
      };
    });
    res.json(indexes);
  } catch (err) {
    res.status(500).json({
      error: "Failed to list indexes",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

// ---------------------------------------------------------------------------
// GET /dev/db/migrations
// ---------------------------------------------------------------------------
type JournalEntry = { idx: number; tag: string };

// Build a stable list of candidate migration roots. We try, in order:
//   1. Anchored at this module's own location (works regardless of cwd,
//      including from esbuild-bundled dist/index.mjs).
//   2. The legacy cwd-based fallbacks, kept for back-compat with any
//      launch context where the module-anchored path doesn't resolve
//      (e.g. tests running source files with a non-standard layout).
//
// Sourcery (PR #56) flagged the cwd-only approach as brittle across
// dev/test/prod launch contexts. Anchoring on import.meta.url removes
// that dependency on `where the process was started from`.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_ROOT_CANDIDATES = [
  // Source layout: artifacts/api-server/src/routes/dev/db.ts
  // → up 5 segments lands at <repo-root>, then into lib/db/migrations
  path.resolve(HERE, "../../../../..", "lib/db/migrations"),
  // Bundled layout: artifacts/api-server/dist/index.mjs
  // → up 3 segments lands at <repo-root>
  path.resolve(HERE, "../..", "lib/db/migrations"),
  // Legacy cwd-based fallbacks
  path.resolve(process.cwd(), "lib/db/migrations"),
  path.resolve(process.cwd(), "../../lib/db/migrations"),
];

async function readJournal(): Promise<JournalEntry[]> {
  for (const root of MIGRATION_ROOT_CANDIDATES) {
    try {
      const raw = await readFile(path.join(root, "meta/_journal.json"), "utf8");
      const parsed = JSON.parse(raw) as { entries?: JournalEntry[] };
      return parsed.entries ?? [];
    } catch {
      // try next candidate
    }
  }
  return [];
}

async function listMigrationFiles(): Promise<string[]> {
  const candidates = MIGRATION_ROOT_CANDIDATES;
  for (const p of candidates) {
    try {
      const entries = await readdir(p);
      return entries
        .filter((f) => f.endsWith(".sql") && !f.endsWith("_down.sql"))
        .sort();
    } catch {
      // try next
    }
  }
  return [];
}

router.get("/db/migrations", async (_req: Request, res: Response) => {
  try {
    const [journal, files] = await Promise.all([
      readJournal(),
      listMigrationFiles(),
    ]);

    // Build the canonical list from the journal (the source of truth for
    // ordering), and supplement with any .sql files not in the journal
    // (which would indicate drift — files exist that drizzle hasn't sealed
    // into the manifest yet).
    const journalTags = new Set(journal.map((j) => j.tag));
    const orphans = files
      .map((f) => f.replace(/\.sql$/, ""))
      .filter((tag) => !journalTags.has(tag))
      .map((tag, i) => ({ idx: journal.length + i, tag }));

    const allEntries = [...journal, ...orphans];

    // Best-effort "applied" lookup. drizzle's table is
    // drizzle.__drizzle_migrations (schema=drizzle, table=__drizzle_migrations).
    // If it doesn't exist (fresh db / different migration tooling) we just
    // omit the field.
    let appliedTags: Set<string> | null = null;
    try {
      const result = await db.execute(sql`
        SELECT hash, created_at
        FROM drizzle.__drizzle_migrations
        ORDER BY created_at
      `);
      // drizzle stores a hash of the migration body, not the tag, so we
      // can't directly match tag→applied. Best we can do: if there are
      // N rows in the migrations table, the first N journal entries are
      // applied. This matches drizzle-kit's own behavior.
      const count = rowsOf(result).length;
      appliedTags = new Set(journal.slice(0, count).map((j) => j.tag));
    } catch {
      appliedTags = null;
    }

    const out = allEntries.map((e) => {
      const base: { idx: number; tag: string; applied?: boolean } = {
        idx: e.idx,
        tag: e.tag,
      };
      if (appliedTags) {
        base.applied = appliedTags.has(e.tag);
      }
      return base;
    });

    res.json(out);
  } catch (err) {
    res.status(500).json({
      error: "Failed to read migrations",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

export default router;
