/**
 * Codebase context bundler for the AI Feature Builder.
 *
 * Produces a single ~8-12k token string that the AI uses as its house-
 * conventions briefing before drafting a plan. The bundle is composed
 * from a handful of always-on read-only sources:
 *
 *   1. A short tech-stack blurb (string constant).
 *   2. The RBAC matrix from `artifacts/api-server/src/lib/permissions.ts`
 *      — pasted verbatim so the model sees the exact Role/Resource/Action
 *      shape it has to satisfy.
 *   3. A schema overview built by scanning every
 *      `lib/db/src/schema/*.ts` and extracting table-name +
 *      column-name + column-type signatures. We DO NOT dump full SQL
 *      because the goal is to keep the bundle compact, and we DO NOT
 *      select sample rows because some tables (`contacts`, etc.) carry
 *      PHI — sampling from them is a HIPAA hazard.
 *   4. A routes inventory pulled from `artifacts/api-server/src/routes/`
 *      (file list + the HTTP verbs/paths discovered by regex).
 *   5. The list of OpenAPI paths from `lib/api-spec/openapi.yaml`
 *      (paths only, never the full per-path schema; that would balloon
 *      the bundle without much benefit).
 *   6. The page inventory from `artifacts/web-app/src/pages/*.tsx`,
 *      cross-referenced against the wouter `<Route>` declarations in
 *      `App.tsx`.
 *   7. A verbatim "Conventions" block that documents the unwritten
 *      house rules (Drizzle-only, safeLimit/safeOffset, PHI masking,
 *      migration idempotency, etc.).
 *
 * Caching: the bundle is the same across all callers for the duration
 * of a session — there is no per-user variation — so we cache it for 60
 * seconds. That trades 60 s of staleness for a meaningful speedup when
 * a developer iterates on plan prompts.
 *
 * PHI safety: the bundler never reads from tables; it only reads from
 * source files. The "schema overview" section lists column names but
 * never any data.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// `lib/devtools/src/codebaseContext.ts` -> repo root = up 3 segments.
// We also fall back to cwd-relative resolution for tests/bundled
// environments where import.meta.url doesn't sit at the expected depth.
const REPO_ROOT_CANDIDATES = [
  path.resolve(HERE, "../../.."),
  process.cwd(),
];

async function resolveRepoRoot(): Promise<string> {
  for (const candidate of REPO_ROOT_CANDIDATES) {
    try {
      await stat(path.join(candidate, "pnpm-workspace.yaml"));
      return candidate;
    } catch {
      // try next
    }
  }
  // Last resort — return the first candidate; downstream file reads
  // will surface the misconfiguration with a clear ENOENT.
  return REPO_ROOT_CANDIDATES[0]!;
}

// ----------------------------- cache --------------------------------------
const CACHE_TTL_MS = 60_000;
let cached: { value: string; expiresAt: number } | null = null;

// ----------------------------- sources ------------------------------------

const TECH_STACK = `
# Tech stack
- Frontend: React 19 + Vite + Tailwind v4 + shadcn/ui + wouter (routing)
- API client: orval-generated; consume via customFetch from @workspace/api-client-react
- Backend: Express 5 + Drizzle ORM + Postgres + pg-boss (job queue)
- Auth: Clerk (clerkMiddleware, getAuth)
- Types: Zod for runtime validation, OpenAPI for client codegen
`.trim();

const CONVENTIONS = `
# House conventions (verbatim — do not break these)
- Use Drizzle for all DB access. Never call \`pg.query\` or write raw SQL
  outside of \`db.execute(sql\` … \`)\` and never against PHI columns.
- Paginated list endpoints MUST use \`safeLimit\`/\`safeOffset\` from
  \`artifacts/api-server/src/lib/listGuards.ts\`. Do not parse limit/offset
  inline.
- Mutating routes MUST chain \`requireAuth\` + \`requirePermission(resource,
  action)\` + \`auditMiddleware(resource)\` in that order.
- Any route that reads \`req.params.id\` MUST normalize first:
  \`const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;\`
  (express 5 occasionally hands back arrays for repeated params).
- Migrations: every \`CREATE TABLE\`/\`CREATE INDEX\` must use
  \`IF NOT EXISTS\`, every \`ALTER TABLE … ADD COLUMN\` must use
  \`ADD COLUMN IF NOT EXISTS\`. Migrations must be idempotent.
- PHI fields — \`medicareId\`, \`dob\`, \`healthConditions\` — must never
  appear in AI prompts. Mask via the \`maskContact\` helper before any
  outbound network call.
- Frontend: use \`customFetch\` from \`@workspace/api-client-react\`. Do not
  call \`fetch\` directly from components.
- Integration tests targeting Express routes go under
  \`artifacts/<package>/src/__tests__/integration/\` and boot pglite via
  \`__tests__/helpers/testDb.ts\`.
`.trim();

// ----------------------------- helpers ------------------------------------

async function safeRead(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

async function safeReaddir(p: string): Promise<string[]> {
  try {
    return await readdir(p);
  } catch {
    return [];
  }
}

/**
 * Pull the `MATRIX`, `Role`, `Resource`, and `Action` declarations
 * out of permissions.ts and return them as a single string. We deliberately
 * don't try to "parse" the TypeScript — we slice the file by the well-known
 * delimiters that the existing source uses, which is sturdy enough for a
 * file that lives in our own repo.
 */
async function buildPermissionsSection(repoRoot: string): Promise<string> {
  const file = path.join(
    repoRoot,
    "artifacts/api-server/src/lib/permissions.ts",
  );
  const raw = await safeRead(file);
  if (!raw) return "# RBAC matrix\n(permissions.ts not found)";

  // Take everything up to and including the MATRIX object literal close.
  // The file declares Role/Resource/Action types, then the MATRIX, then
  // helper functions. We want types + matrix only.
  const matrixEnd = raw.indexOf("};", raw.indexOf("const MATRIX"));
  const slice =
    matrixEnd > 0 ? raw.slice(0, matrixEnd + 2) : raw.slice(0, 4000);
  return `# RBAC matrix (verbatim from artifacts/api-server/src/lib/permissions.ts)\n\n\`\`\`ts\n${slice}\n\`\`\``;
}

/**
 * Schema overview — table name + column signatures only.
 *
 * We regex-extract the drizzle pgTable declarations rather than importing
 * the schema module. The schema module pulls in drizzle and the postgres
 * driver, which is too heavy a dependency for a read-only context bundle
 * that may run in unit tests without a live DB.
 */
async function buildSchemaSection(repoRoot: string): Promise<string> {
  const schemaDir = path.join(repoRoot, "lib/db/src/schema");
  const files = await safeReaddir(schemaDir);
  const tsFiles = files.filter(
    (f) => f.endsWith(".ts") && f !== "index.ts",
  );

  const tableRe =
    /export\s+const\s+(\w+)\s*=\s*pgTable\(\s*"([^"]+)"\s*,\s*\{([\s\S]*?)\}\s*(?:,\s*\([\s\S]*?\)\s*=>[\s\S]*?)?\)/g;
  const colRe = /(\w+)\s*:\s*(\w+)\(/g;

  const out: string[] = [];
  for (const f of tsFiles) {
    const raw = await safeRead(path.join(schemaDir, f));
    if (!raw) continue;
    let m: RegExpExecArray | null;
    while ((m = tableRe.exec(raw)) !== null) {
      const tableName = m[2]!;
      const body = m[3]!;
      const cols: string[] = [];
      let c: RegExpExecArray | null;
      while ((c = colRe.exec(body)) !== null) {
        // Skip keys whose drizzle helper looks like an option object key
        // (e.g. `references`, `default`); we only want column definitions
        // whose RHS is a column-builder function call (one of the small
        // set below).
        const builder = c[2]!;
        if (
          [
            "varchar",
            "text",
            "integer",
            "bigint",
            "boolean",
            "timestamp",
            "date",
            "jsonb",
            "json",
            "uuid",
            "serial",
            "numeric",
            "real",
            "doublePrecision",
            "smallint",
            "decimal",
            "pgEnum",
          ].includes(builder)
        ) {
          cols.push(`${c[1]}:${builder}`);
        }
      }
      out.push(`- ${tableName} (${cols.join(", ")})`);
    }
  }

  return `# Schema overview (${out.length} tables, signatures only — no data)\n\n${out.join("\n")}`;
}

/**
 * Routes inventory.
 *
 * For each .ts file under artifacts/api-server/src/routes (recursively),
 * grep for `router.<verb>("/path"` calls and emit a one-line summary.
 */
async function buildRoutesSection(repoRoot: string): Promise<string> {
  const root = path.join(repoRoot, "artifacts/api-server/src/routes");
  const lines: string[] = [];

  async function walk(dir: string, rel: string): Promise<void> {
    const entries = await safeReaddir(dir);
    for (const e of entries) {
      const full = path.join(dir, e);
      let s;
      try {
        s = await stat(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        await walk(full, path.join(rel, e));
      } else if (e.endsWith(".ts")) {
        const raw = await safeRead(full);
        if (!raw) continue;
        const verbs: string[] = [];
        const re = /router\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(raw)) !== null) {
          verbs.push(`${m[1]!.toUpperCase()} ${m[2]!}`);
        }
        if (verbs.length > 0) {
          lines.push(`- ${path.join(rel, e)}: ${verbs.join(", ")}`);
        }
      }
    }
  }

  await walk(root, "");
  return `# Routes inventory (artifacts/api-server/src/routes)\n\n${lines.join("\n")}`;
}

/**
 * OpenAPI paths — just the keys directly under `paths:`. We deliberately
 * do not include the per-method schema, request bodies, or responses
 * because the OpenAPI spec balloons fast and we already cover the same
 * surface in the routes inventory.
 */
async function buildOpenApiSection(repoRoot: string): Promise<string> {
  const file = path.join(repoRoot, "lib/api-spec/openapi.yaml");
  const raw = await safeRead(file);
  if (!raw) return "# OpenAPI paths\n(openapi.yaml not found)";

  // Capture lines that look like top-level path keys: 2 leading spaces,
  // a leading slash, then a colon. This matches the YAML shape under
  // `paths:` without us having to parse YAML.
  const paths = raw
    .split("\n")
    .filter((line) => /^ {2}\/[^\s].*:$/.test(line))
    .map((line) => line.trim().replace(/:$/, ""));
  return `# OpenAPI paths (${paths.length} total)\n\n${paths.map((p) => `- ${p}`).join("\n")}`;
}

/**
 * Page inventory — `*.tsx` under web-app/src/pages, cross-ref'd against
 * the wouter <Route> table in App.tsx.
 */
async function buildPagesSection(repoRoot: string): Promise<string> {
  const pagesDir = path.join(repoRoot, "artifacts/web-app/src/pages");
  const appTsx = path.join(repoRoot, "artifacts/web-app/src/App.tsx");

  const files = (await safeReaddir(pagesDir)).filter((f) => f.endsWith(".tsx"));
  const app = (await safeRead(appTsx)) ?? "";

  // Extract every <Route path="…"> declaration. We don't try to match
  // these up to component imports — the file list alone gives the model
  // enough to find what it needs.
  const routePaths: string[] = [];
  const re = /<Route\s+path="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(app)) !== null) routePaths.push(m[1]!);

  return [
    `# Page inventory (artifacts/web-app/src/pages)`,
    "",
    ...files.map((f) => `- ${f}`),
    "",
    `# Wouter routes from App.tsx`,
    "",
    ...routePaths.map((p) => `- ${p}`),
  ].join("\n");
}

// ----------------------------- public API ---------------------------------

/**
 * Build the context bundle. Cached for 60 s.
 *
 * Pass `{ force: true }` to bypass the cache (used by tests that need
 * deterministic behavior across runs).
 */
export async function buildCodebaseContext(
  opts: { force?: boolean } = {},
): Promise<string> {
  if (!opts.force && cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const repoRoot = await resolveRepoRoot();
  const [permissions, schema, routes, openapi, pages] = await Promise.all([
    buildPermissionsSection(repoRoot),
    buildSchemaSection(repoRoot),
    buildRoutesSection(repoRoot),
    buildOpenApiSection(repoRoot),
    buildPagesSection(repoRoot),
  ]);

  const value = [
    TECH_STACK,
    "",
    permissions,
    "",
    schema,
    "",
    routes,
    "",
    openapi,
    "",
    pages,
    "",
    CONVENTIONS,
  ].join("\n");

  cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

/** Test-only — clears the cache so successive tests don't see stale values. */
export function _clearCodebaseContextCache(): void {
  cached = null;
}
