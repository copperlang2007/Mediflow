/**
 * Integration test: export-volume anomaly detector.
 *
 * Drives the cron worker (`exportAnomalyCheckWorker`) directly against the
 * pglite db so we exercise the real drizzle queries, the real stats math,
 * and the real `breach_notifications` insert. pg-boss is not involved.
 *
 * Scenarios:
 *  1. Anomaly: ~3 exports/day for 30 days, then 30 exports today → expects
 *     exactly one `medium` severity breach_notifications row tagged
 *     `export_anomaly_alert`.
 *  2. Idempotency: a second worker invocation on the same UTC day must NOT
 *     produce a second row.
 *  3. Normal traffic: ~3 exports/day for 30 days, then 3 exports today →
 *     expects zero anomaly rows.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

const { dbF, jobsF } = vi.hoisted(() => ({
  dbF: async (): Promise<Record<string, unknown>> => {
    const { dbMockFactory } = await import("../helpers/testApp");
    return dbMockFactory();
  },
  jobsF: async (): Promise<Record<string, unknown>> => {
    const { jobsMockFactory } = await import("../helpers/testApp");
    return jobsMockFactory();
  },
}));

vi.mock("@workspace/db", dbF);
vi.mock("../../lib/jobs", jobsF);

import { and, eq } from "drizzle-orm";
import {
  breachNotificationsTable,
  dataExportLogTable,
} from "@workspace/db/schema";
import { bootTestDb, shutdownTestDb } from "../helpers/testApp";
import { seedOrg, seedUser } from "../helpers/testDb";
import { randomUUID } from "node:crypto";

let handle: Awaited<ReturnType<typeof bootTestDb>>;
let runWorker: typeof import("../../workers/exportAnomalyCheck").exportAnomalyCheckWorker;

const DAY_MS = 24 * 60 * 60 * 1000;

async function seedExports(
  orgId: string,
  userId: string,
  createdAt: Date,
  count: number,
): Promise<void> {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: `${randomUUID()}-${i}`,
    orgId,
    userId,
    exportType: "test_csv",
    recordCount: 1,
    createdAt: new Date(createdAt.getTime() + i * 1000), // sprinkle so timestamps differ
  }));
  await handle.db.insert(dataExportLogTable).values(rows);
}

/**
 * Seed `~exportsPerDay` exports on each of the last 30 calendar days,
 * skipping the trailing 24h (that bucket is what the test is asserting on
 * separately).
 */
async function seedBackground(
  orgId: string,
  userId: string,
  exportsPerDay: number,
  now: Date,
): Promise<number> {
  let total = 0;
  // i=2..29 → 28 historical days, each stamped at the midpoint of its UTC
  // day so it can't bleed into the trailing 24h "today" bucket regardless of
  // exact wall-clock time when the test runs.
  for (let i = 2; i < 30; i++) {
    const when = new Date(now.getTime() - i * DAY_MS + 12 * 60 * 60 * 1000);
    await seedExports(orgId, userId, when, exportsPerDay);
    total += exportsPerDay;
  }
  return total;
}

async function countAnomalyRows(orgId: string): Promise<number> {
  const rows = await handle.db
    .select({ id: breachNotificationsTable.id })
    .from(breachNotificationsTable)
    .where(
      and(
        eq(breachNotificationsTable.orgId, orgId),
        eq(breachNotificationsTable.detectedBySystem, "export_anomaly_alert"),
      ),
    );
  return rows.length;
}

beforeAll(async () => {
  handle = await bootTestDb();
  runWorker = (await import("../../workers/exportAnomalyCheck"))
    .exportAnomalyCheckWorker;
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("exportAnomalyCheckWorker", () => {
  it("raises one medium-severity breach row when today's volume spikes past +3σ", async () => {
    const org = await seedOrg(handle.db, { id: "export-anomaly-spike-org" });
    const user = await seedUser(handle.db, { orgId: org.id, role: "agent" });
    const now = new Date();

    // ~3 exports/day across 29 historical days, then 30 in the trailing 24h.
    // Mean ≈ 3, σ small → threshold well under 30, anomaly fires.
    await seedBackground(org.id, user.id, 3, now);
    await seedExports(
      org.id,
      user.id,
      new Date(now.getTime() - 60 * 60 * 1000), // 1h ago
      30,
    );

    await runWorker();

    expect(await countAnomalyRows(org.id)).toBe(1);

    const [row] = await handle.db
      .select()
      .from(breachNotificationsTable)
      .where(eq(breachNotificationsTable.orgId, org.id));

    expect(row.severity).toBe("medium");
    expect(row.status).toBe("open");
    expect(row.detectedBySystem).toBe("export_anomaly_alert");
    expect(row.affectedRecordType).toBe("export_volume");
    expect(row.affectedRecordCount).toBe(30);
    expect(row.notificationRequired).toBe(false);
    expect(row.description).toMatch(/Export volume anomaly: 30 exports/);
  });

  it("is idempotent — a second run on the same day does not insert a duplicate", async () => {
    // Reuse the same org from the previous test: the row from run #1 should
    // suppress a row from run #2.
    const orgId = "export-anomaly-spike-org";

    await runWorker();

    expect(await countAnomalyRows(orgId)).toBe(1);
  });

  it("does not raise an alert when today's volume is within the normal band", async () => {
    const org = await seedOrg(handle.db, { id: "export-anomaly-normal-org" });
    const user = await seedUser(handle.db, { orgId: org.id, role: "agent" });
    const now = new Date();

    await seedBackground(org.id, user.id, 3, now);
    // 3 exports in the last 24h matches the background → not an anomaly.
    await seedExports(
      org.id,
      user.id,
      new Date(now.getTime() - 60 * 60 * 1000),
      3,
    );

    await runWorker();

    expect(await countAnomalyRows(org.id)).toBe(0);
  });
});
