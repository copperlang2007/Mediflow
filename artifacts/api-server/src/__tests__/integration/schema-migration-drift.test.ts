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
});
