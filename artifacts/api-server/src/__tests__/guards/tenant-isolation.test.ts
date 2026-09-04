/**
 * Tenant-isolation static guard.
 *
 * Tenant separation in this codebase is enforced in application code: a route
 * that touches an org-scoped table either filters on `authReq.orgId` directly
 * or validates ownership first via a helper it passes `authReq.orgId` to
 * (`getAgentOrFail(agentId, authReq.orgId, res)` and friends). That is correct
 * in every route today — but it is a convention, and a convention is one
 * forgotten filter away from a cross-tenant PHI leak. There is no Postgres RLS
 * backstop yet (see docs/decisions/0002-tenant-isolation-strategy.md for why,
 * and the plan to add one), so this test IS the backstop.
 *
 * Granularity is the whole route handler, not the individual statement. That
 * is deliberate and matches how the code actually establishes tenancy: the org
 * check is frequently an early-return ownership guard, or a `conditions[]`
 * array assembled several lines above the query. Statement-level checking
 * flagged ~90 such cases, all false positives. Handler-level checking catches
 * the failure mode that actually matters — a route that is org-unaware end to
 * end.
 *
 * Genuinely org-agnostic handler? Annotate it with
 * `// tenant-isolation-exempt: <reason>`. The exemption lands in the diff and
 * gets reviewed like any other security decision, which is the point.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROUTES_DIR = join(__dirname, "..", "..", "routes");
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");

/**
 * Tables with no `org_id` column — legitimately global or self-scoping.
 * Everything NOT listed here is treated as org-scoped, so a newly added tenant
 * table is guarded by default rather than by remembering to opt in.
 * Fail-closed is the whole design.
 */
const GLOBAL_TABLES = new Set([
  "organizationsTable", // the tenant root itself, scoped by its own PK
  "sessionActivityTable", // keyed by Clerk session id
  "billingEventsTable", // webhook ledger, keyed by the provider's event id
]);

/**
 * References that establish tenancy inside a handler: a direct org filter, or
 * an identity-derived primary key (`/users/me` filters `usersTable.id` by
 * `authReq.userId`, which is strictly narrower than an org filter).
 */
const TENANCY_PATTERN = /\borgId\b|\borg_id\b|\bauthReq\.userId\b/;

const TABLE_REF = new RegExp(
  [
    /\.from\(\s*([A-Za-z_$][\w$]*)/,
    /\.into\(\s*([A-Za-z_$][\w$]*)/,
    /\.insert\(\s*([A-Za-z_$][\w$]*)/,
    /\.update\(\s*([A-Za-z_$][\w$]*)/,
    /\.delete\(\s*([A-Za-z_$][\w$]*)/,
    /\.innerJoin\(\s*([A-Za-z_$][\w$]*)/,
    /\.leftJoin\(\s*([A-Za-z_$][\w$]*)/,
  ]
    .map((r) => r.source)
    .join("|"),
  "g",
);

/** Start of an Express route registration: `router.get(`, `router.post(`, … */
const HANDLER_START =
  /\brouter\s*\.\s*(?:get|post|put|patch|delete|all|use)\s*\(/g;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** Slice a route module into one chunk per registered handler. */
function extractHandlers(source: string): { text: string; line: number }[] {
  const starts: number[] = [];
  HANDLER_START.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HANDLER_START.exec(source)) !== null) starts.push(m.index);

  return starts.map((start, i) => ({
    text: source.slice(
      start,
      i + 1 < starts.length ? starts[i + 1] : source.length,
    ),
    line: source.slice(0, start).split("\n").length,
  }));
}

/**
 * Identifiers a module imports from `@workspace/db`.
 *
 * Only these count as tables. Without this, `.delete(k)` on a plain `Map`
 * looks exactly like `.delete(someTable)` to a regex — resolving against the
 * real import list is what keeps the guard precise enough to stay enabled.
 */
function dbImportsIn(source: string): Set<string> {
  const names = new Set<string>();
  const importRe = /import\s*\{([^}]*)\}\s*from\s*["']@workspace\/db["']/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(source)) !== null) {
    for (const raw of m[1].split(",")) {
      // Handles `foo`, `foo as bar`, and `type Foo` specifiers alike.
      const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop();
      if (name) names.add(name.trim());
    }
  }
  return names;
}

function orgScopedTablesIn(handler: string, dbImports: Set<string>): string[] {
  const found = new Set<string>();
  TABLE_REF.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TABLE_REF.exec(handler)) !== null) {
    const name = m.slice(1).find(Boolean);
    if (name && dbImports.has(name) && !GLOBAL_TABLES.has(name)) found.add(name);
  }
  return [...found];
}

describe("tenant isolation", () => {
  const routeFiles = walk(ROUTES_DIR).filter((f) => !f.includes("__tests__"));

  it("finds route modules to check", () => {
    // Guards the guard: a refactor that moves or renames the routes directory
    // must not silently turn this suite into a no-op that passes on zero files.
    expect(routeFiles.length).toBeGreaterThan(30);
  });

  it("inspects a meaningful number of handlers", () => {
    const total = routeFiles.reduce(
      (n, f) => n + extractHandlers(readFileSync(f, "utf8")).length,
      0,
    );
    expect(total).toBeGreaterThan(100);
  });

  it("establishes tenancy in every handler touching an org-scoped table", () => {
    const violations: string[] = [];

    for (const file of routeFiles) {
      const source = readFileSync(file, "utf8");
      const dbImports = dbImportsIn(source);
      if (dbImports.size === 0) continue;

      for (const { text, line } of extractHandlers(source)) {
        if (text.includes("tenant-isolation-exempt")) continue;

        const tables = orgScopedTablesIn(text, dbImports);
        if (tables.length === 0) continue;
        if (TENANCY_PATTERN.test(text)) continue;

        violations.push(
          `${relative(REPO_ROOT, file)}:${line} — handler queries ` +
            `${tables.join(", ")} without establishing tenancy`,
        );
      }
    }

    expect(
      violations,
      violations.length
        ? `Handlers touching org-scoped tables must establish tenancy.\n` +
            `Filter on authReq.orgId, or validate ownership through a helper\n` +
            `you pass authReq.orgId to. If the handler is genuinely\n` +
            `org-agnostic, annotate it with\n` +
            `"// tenant-isolation-exempt: <reason>".\n\n` +
            violations.map((v) => `  - ${v}`).join("\n")
        : undefined,
    ).toEqual([]);
  });
});
