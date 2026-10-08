/**
 * Migration 0070: move artificialBRIDGE clients into INSUREitALL.
 * The harness already replayed 0070 on an empty DB (a no-op); here we seed
 * two orgs and re-run the migration SQL to check the move and its guards.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  setupTestDb,
  teardownTestDb,
  seedOrg,
  seedAgent,
  seedContact,
  type TestDbHandle,
} from "../helpers/testDb";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(
  path.resolve(
    __dirname,
    "../../../../../lib/db/migrations/0070_move_artificialbridge_clients_to_insureitall.sql",
  ),
  "utf8",
);

let h: TestDbHandle;
beforeAll(async () => {
  h = await setupTestDb();
});
afterAll(async () => {
  await teardownTestDb(h);
});

const orgOf = async (table: string, id: string) =>
  (await h.pg.query<{ org_id: string }>(`SELECT org_id FROM ${table} WHERE id = $1`, [id]))
    .rows[0]?.org_id;

describe("migration 0070", () => {
  it("moves contacts + children, clears agent, leaves others, is idempotent", async () => {
    const src = await seedOrg(h.db, { name: "artificialBRIDGE", slug: "artificialbridge" });
    const dst = await seedOrg(h.db, { name: "INSUREitALL", slug: "insureitall" });
    const other = await seedOrg(h.db, { name: "Someone Else" });
    const agent = await seedAgent(h.db, { orgId: src.id });
    const moved = await seedContact(h.db, { orgId: src.id });
    const stays = await seedContact(h.db, { orgId: other.id });
    await h.pg.query(`UPDATE contacts SET assigned_agent_id = $1 WHERE id = $2`, [agent.id, moved.id]);
    await h.pg.query(
      `INSERT INTO message_threads (id, org_id, contact_id, channel) VALUES ('t-moved', $1, $2, 'sms'), ('t-stays', $3, $4, 'sms')`,
      [src.id, moved.id, other.id, stays.id],
    );

    await h.pg.exec(SQL);

    expect(await orgOf("contacts", moved.id)).toBe(dst.id);
    expect(await orgOf("message_threads", "t-moved")).toBe(dst.id);
    expect(await orgOf("contacts", stays.id)).toBe(other.id);
    expect(await orgOf("message_threads", "t-stays")).toBe(other.id);
    const a = await h.pg.query<{ assigned_agent_id: string | null }>(
      `SELECT assigned_agent_id FROM contacts WHERE id = $1`, [moved.id]);
    expect(a.rows[0].assigned_agent_id).toBeNull();
    expect(await orgOf("agents", agent.id)).toBe(src.id);

    await h.pg.exec(SQL); // second run: no-op
    expect(await orgOf("contacts", moved.id)).toBe(dst.id);
  });

  it("does nothing when an org is ambiguous or missing", async () => {
    await seedOrg(h.db, { name: "INSUREitALL LLC", slug: "insureitall-llc" }); // 2nd match for dst
    const src2 = await seedOrg(h.db, { name: "artificial bridge", slug: "artificial-bridge" }); // 2nd src
    const c = await seedContact(h.db, { orgId: src2.id });
    await h.pg.exec(SQL);
    expect(await orgOf("contacts", c.id)).toBe(src2.id);
  });
});
