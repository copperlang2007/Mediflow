/**
 * Drift guard: every table and column the drizzle schema declares must
 * actually exist after replaying the checked-in SQL migrations.
 *
 * Production runs ONLY the SQL migrations (via the journal); the drizzle
 * schema is what route handlers query against. A table added to the schema
 * without a migration (e.g. `renewal_snoozes`, which made /api/renewals 500)
 * type-checks fine and only fails at request time. The pglite harness
 * replays the same SQL files, so comparing it against the schema catches
 * that class of bug in CI.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@workspace/db/schema";
import {
  setupTestDb,
  teardownTestDb,
  type TestDbHandle,
} from "../helpers/testDb";

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb(handle);
});

describe("drizzle schema vs SQL migrations", () => {
  it("every schema table and column exists in the migrated database", async () => {
    const res = await handle.pg.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`,
    );
    const actual = new Map<string, Set<string>>();
    for (const r of res.rows) {
      if (!actual.has(r.table_name)) actual.set(r.table_name, new Set());
      actual.get(r.table_name)!.add(r.column_name);
    }

    const missing: string[] = [];
    const seen = new Set<string>();
    for (const value of Object.values(schema)) {
      if (!(value instanceof PgTable)) continue;
      const cfg = getTableConfig(value);
      if (seen.has(cfg.name)) continue;
      seen.add(cfg.name);
      const cols = actual.get(cfg.name);
      if (!cols) {
        missing.push(`table ${cfg.name}`);
        continue;
      }
      for (const c of cfg.columns) {
        if (!cols.has(c.name)) missing.push(`column ${cfg.name}.${c.name}`);
      }
    }

    expect(seen.size).toBeGreaterThan(10);
    expect(missing).toEqual([]);
  });

  it("every schema foreign key exists in the migrated database", async () => {
    const actual = await foreignKeys();
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const value of Object.values(schema)) {
      if (!(value instanceof PgTable)) continue;
      const cfg = getTableConfig(value);
      if (seen.has(cfg.name)) continue;
      seen.add(cfg.name);
      for (const fk of cfg.foreignKeys) {
        const ref = fk.reference();
        const key = fkKey(
          cfg.name,
          ref.columns.map((c) => c.name),
          getTableConfig(ref.foreignTable).name,
        );
        if (!actual.has(key)) missing.push(key);
      }
    }
    expect(missing).toEqual([]);
  });

  it("migration 0049 restores foreign keys on tables that already exist", async () => {
    // Simulate a `drizzle-kit push` environment: tables present, FKs absent.
    await handle.pg.exec(`
      ALTER TABLE "renewal_snoozes" DROP CONSTRAINT "renewal_snoozes_org_id_organizations_id_fk";
      ALTER TABLE "cert_renewal_alerts" DROP CONSTRAINT "cert_renewal_alerts_cert_id_carrier_certifications_id_fk";
    `);
    const file = fileURLToPath(
      new URL("../../../../../lib/db/migrations/0049_schema_drift_renewals.sql", import.meta.url),
    );
    await handle.pg.exec(readFileSync(file, "utf8").replaceAll("--> statement-breakpoint", ""));

    const actual = await foreignKeys();
    expect(actual.has(fkKey("renewal_snoozes", ["org_id"], "organizations"))).toBe(true);
    expect(actual.has(fkKey("cert_renewal_alerts", ["cert_id"], "carrier_certifications"))).toBe(true);

    // Re-running on an already-complete database is a no-op, not an error.
    await expect(
      handle.pg.exec(readFileSync(file, "utf8").replaceAll("--> statement-breakpoint", "")),
    ).resolves.toBeDefined();
  });
});

function fkKey(table: string, columns: string[], foreignTable: string): string {
  return `${table}(${columns.join(",")}) -> ${foreignTable}`;
}

async function foreignKeys(): Promise<Set<string>> {
  const res = await handle.pg.query<{ table_name: string; columns: string; foreign_table: string }>(
    `SELECT c.conrelid::regclass::text AS table_name,
            c.confrelid::regclass::text AS foreign_table,
            (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
               FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS columns
       FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE c.contype = 'f' AND n.nspname = 'public'`,
  );
  const strip = (t: string) => t.replace(/^public\./, "").replace(/"/g, "");
  return new Set(
    res.rows.map((r) => fkKey(strip(r.table_name), r.columns.split(","), strip(r.foreign_table))),
  );
}
