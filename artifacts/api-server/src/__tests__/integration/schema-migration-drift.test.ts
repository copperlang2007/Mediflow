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

  const replay = (name: string) =>
    handle.pg.exec(
      readFileSync(
        fileURLToPath(new URL(`../../../../../lib/db/migrations/${name}.sql`, import.meta.url)),
        "utf8",
      ).replaceAll("--> statement-breakpoint", ""),
    );

  async function fkCount(table: string, foreignTable: string): Promise<number> {
    const res = await handle.pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_constraint
        WHERE contype = 'f' AND conrelid = $1::regclass AND confrelid = $2::regclass`,
      [table, foreignTable],
    );
    return res.rows[0]?.n ?? 0;
  }

  it("the backfill migrations restore foreign keys on tables that already exist", async () => {
    // Simulate a `drizzle-kit push` environment: tables present, FKs absent.
    await handle.pg.exec(`
      ALTER TABLE "renewal_snoozes" DROP CONSTRAINT "renewal_snoozes_org_id_organizations_id_fk";
      ALTER TABLE "cert_renewal_alerts" DROP CONSTRAINT "cert_renewal_alerts_cert_id_carrier_certifications_id_fk";
    `);
    await replay("0049_renewal_snoozes");
    await replay("0050_schema_drift_backfill");

    const actual = await foreignKeys();
    expect(actual.has(fkKey("renewal_snoozes", ["org_id"], "organizations"))).toBe(true);
    expect(actual.has(fkKey("cert_renewal_alerts", ["cert_id"], "carrier_certifications"))).toBe(true);

    // Re-running on an already-complete database is a no-op, not an error.
    await expect(replay("0050_schema_drift_backfill")).resolves.toBeDefined();
  });

  it("does not add a second FK when a pushed DB has it under another name", async () => {
    await handle.pg.exec(`
      ALTER TABLE "cert_renewal_alerts" DROP CONSTRAINT "cert_renewal_alerts_cert_id_carrier_certifications_id_fk";
      ALTER TABLE "cert_renewal_alerts" ADD CONSTRAINT "cert_renewal_alerts_cert_fk"
        FOREIGN KEY ("cert_id") REFERENCES "carrier_certifications"("id") ON DELETE cascade;
    `);
    await replay("0050_schema_drift_backfill");
    expect(await fkCount("cert_renewal_alerts", "carrier_certifications")).toBe(1);
  });

  it("builds the unique alert index even when duplicate rows already exist", async () => {
    await handle.pg.exec(`
      DROP INDEX "cert_renewal_alerts_cert_threshold_unique";
      INSERT INTO organizations (id, name, slug) VALUES ('drift-org', 'Drift', 'drift-org');
      INSERT INTO agents (id, org_id, first_name, last_name, email)
        VALUES ('drift-agent', 'drift-org', 'D', 'A', 'drift@agency.example');
      INSERT INTO carriers (id, org_id, name) VALUES ('drift-carrier', 'drift-org', 'Drift Health');
      INSERT INTO carrier_certifications (id, agent_id, carrier_id, certification_year)
        VALUES ('drift-cert', 'drift-agent', 'drift-carrier', 2026);
      INSERT INTO cert_renewal_alerts (id, cert_id, alert_days_before)
        VALUES ('dup-1', 'drift-cert', 30), ('dup-2', 'drift-cert', 30);
    `);
    await replay("0050_schema_drift_backfill");
    const rows = await handle.pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM cert_renewal_alerts WHERE cert_id = 'drift-cert'`,
    );
    expect(rows.rows[0]?.n).toBe(1);
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
