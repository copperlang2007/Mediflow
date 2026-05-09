/**
 * In-process Postgres test harness backed by `@electric-sql/pglite`.
 *
 * - `setupTestDb()` boots a fresh PGlite instance, runs every migration in
 *   `lib/db/migrations/*.sql` (in lexical order, splitting on the
 *   drizzle-emitted `--> statement-breakpoint` marker) and returns a
 *   drizzle handle plus the raw client.
 * - `seedOrg() / seedUser() / seedAgent() / seedContact()` insert the
 *   minimum-viable rows needed for integration tests against the API.
 * - `teardownTestDb()` closes the PGlite handle.
 *
 * We intentionally keep this file dependency-free of `@workspace/db`'s `db`
 * export so the vi.mock factories that wire it in can import it without
 * circularity. We DO import the schema definitions, since those don't
 * touch the Postgres pool.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@workspace/db/schema";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

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

export async function setupTestDb(): Promise<TestDbHandle> {
  const pg = new PGlite();
  await pg.query("SELECT 1"); // wait for ready

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

  // Schema drift compensation:
  //
  // The drizzle SCHEMA (./lib/db/src/schema/*.ts) is the source of truth and
  // production runs `drizzle-kit push` to keep Postgres in sync. The committed
  // SQL migration files (./lib/db/migrations/*.sql) lag behind on a handful
  // of tables/columns. Since tests bypass drizzle-kit and replay raw SQL,
  // we patch the missing pieces here so the routes don't 500 on tables that
  // would exist in production. Each statement is idempotent.
  await pg.exec(
    `ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;`,
  );

  // org_settings — read by requireAuth to resolve the session timeout
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS "org_settings" (
      "id" text PRIMARY KEY NOT NULL,
      "org_id" text NOT NULL UNIQUE REFERENCES "organizations"("id") ON DELETE cascade,
      "ahip_season_open_month" integer NOT NULL DEFAULT 7,
      "ahip_season_open_day" integer NOT NULL DEFAULT 1,
      "ahip_deadline_month" integer NOT NULL DEFAULT 12,
      "ahip_deadline_day" integer NOT NULL DEFAULT 7,
      "ahip_reminder_enabled" boolean NOT NULL DEFAULT true,
      "ahip_reminder_interval_weeks" integer NOT NULL DEFAULT 2,
      "session_timeout_minutes" integer NOT NULL DEFAULT 30
    );
  `);

  // session_activity — written on every authenticated request
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS "session_activity" (
      "session_id" text PRIMARY KEY NOT NULL,
      "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
      "last_active_at" timestamp with time zone NOT NULL DEFAULT now(),
      "expires_at" timestamp with time zone NOT NULL
    );
  `);

  // login_events / data_export_log / data_retention_policies — accessed by admin routes
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS "login_events" (
      "id" text PRIMARY KEY NOT NULL,
      "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
      "user_id" text REFERENCES "users"("id") ON DELETE set null,
      "email" text,
      "success" boolean NOT NULL,
      "ip_address" text,
      "user_agent" text,
      "failure_reason" text,
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    );
  `);
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS "data_export_log" (
      "id" text PRIMARY KEY NOT NULL,
      "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
      "user_id" text REFERENCES "users"("id") ON DELETE set null,
      "export_type" text NOT NULL,
      "filters" jsonb,
      "record_count" integer,
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    );
  `);
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS "data_retention_policies" (
      "id" text PRIMARY KEY NOT NULL,
      "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
      "record_type" text NOT NULL,
      "retention_days" integer NOT NULL DEFAULT 2555,
      "is_enabled" boolean NOT NULL DEFAULT false,
      "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_by_user_id" text
    );
  `);

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
): Promise<schema.Contact> {
  const id = opts.id ?? `contact-${randomUUID()}`;
  const [row] = await db
    .insert(schema.contactsTable)
    .values({
      id,
      orgId: opts.orgId,
      firstName: opts.firstName ?? "Jane",
      lastName: opts.lastName ?? "Doe",
      email: opts.email ?? null,
      dob: opts.dob ?? null,
      medicareId: opts.medicareId ?? null,
      healthConditions: opts.healthConditions ?? null,
      status: opts.status ?? "lead",
      leadSource: opts.leadSource ?? null,
    })
    .returning();
  return row;
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
