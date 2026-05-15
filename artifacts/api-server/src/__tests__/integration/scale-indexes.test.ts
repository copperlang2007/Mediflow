/**
 * Migration test: pre-launch scale-audit indexes (migration 0016).
 *
 * The test harness (helpers/testDb.ts) boots a fresh PGlite instance and
 * replays every migration file in lexical order. This test asserts that
 * after that replay the two scale indexes from 0016_scale_indexes.sql
 * physically exist with the expected columns in the expected order:
 *
 *   - H1: message_threads (contact_id, org_id, channel) — hot path for the
 *     Twilio inbound SMS webhook and the contact-detail page.
 *   - H2: commission_line_items (org_id, writing_agent_id, period_start) —
 *     covers the GET /agents/:id/commissions period-filtered report.
 *
 * If a future migration renumber drops or renames these, this test fails
 * loudly rather than silently regressing to a sequential scan.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
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

async function indexDef(name: string): Promise<string | null> {
  const res = await handle.pg.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE indexname = $1`,
    [name],
  );
  return res.rows[0]?.indexdef ?? null;
}

describe("scale indexes (migration 0016)", () => {
  it("creates the message_threads contact lookup index", async () => {
    const def = await indexDef("message_threads_contact_id_org_channel_idx");
    expect(def).not.toBeNull();
    // Columns must appear in (contact_id, org_id, channel) order — the
    // ordering is load-bearing for the webhook's contact_id+channel lookup.
    expect(def).toMatch(/\bcontact_id\b[\s\S]*\borg_id\b[\s\S]*\bchannel\b/);
    expect(def).toMatch(/\bON\b[\s\S]*\bmessage_threads\b/);
  });

  it("creates the commission_line_items per-agent period index", async () => {
    const def = await indexDef("commission_line_items_org_agent_period_idx");
    expect(def).not.toBeNull();
    // Equality columns (org_id, writing_agent_id) lead, range column
    // (period_start) last.
    expect(def).toMatch(
      /\borg_id\b[\s\S]*\bwriting_agent_id\b[\s\S]*\bperiod_start\b/,
    );
    expect(def).toMatch(/\bON\b[\s\S]*\bcommission_line_items\b/);
  });
});
