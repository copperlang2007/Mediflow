/**
 * Session timeout enforcement — regression guard for the HIPAA technical
 * safeguard wired into `requireAuth`.
 *
 * Audit found this is fully enforced (Case A in the spec): `requireAuth`
 * reads `org_settings.session_timeout_minutes`, compares the row in
 * `session_activity` to now(), evicts when stale, and upserts a fresh
 * `last_active_at` on every authenticated request. These tests assert the
 * end-to-end behaviour from the route surface so a regression cannot
 * silently disable it.
 */
import {
  vi,
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";

const { dbF, clerkF, jobsF } = vi.hoisted(() => ({
  dbF: async (): Promise<Record<string, unknown>> => {
    const { dbMockFactory } = await import("../helpers/testApp");
    return dbMockFactory();
  },
  clerkF: async (): Promise<Record<string, unknown>> => {
    const { clerkMockFactory } = await import("../helpers/testApp");
    return clerkMockFactory();
  },
  jobsF: async (): Promise<Record<string, unknown>> => {
    const { jobsMockFactory } = await import("../helpers/testApp");
    return jobsMockFactory();
  },
}));

vi.mock("@workspace/db", dbF);
vi.mock("@clerk/express", clerkF);
vi.mock("../../lib/jobs", jobsF);

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  orgSettingsTable,
  sessionActivityTable,
} from "@workspace/db/schema";
import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser } from "../helpers/testDb";

import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");

let org: { id: string };
let user: { id: string };

beforeAll(async () => {
  const handle = await bootTestDb();
  app = (await import("../../app")).default;
  request = (await import("supertest") as any).default;

  org = await seedOrg(handle.db, { id: "session-timeout-org" });
  // Set the session timeout to 30 minutes. This row exists for the entire
  // suite — individual tests mutate the `session_activity` table to
  // simulate idle time, never `org_settings`.
  await handle.db.insert(orgSettingsTable).values({
    id: randomUUID(),
    orgId: org.id,
    sessionTimeoutMinutes: 30,
  });
  user = await seedUser(handle.db, {
    orgId: org.id,
    role: "agency_admin",
  });
});

afterAll(async () => {
  await shutdownTestDb();
});

beforeEach(async () => {
  // Each test starts from a clean session_activity table so the in-process
  // 60-second cache in requireAuth doesn't carry state across tests. The
  // cache is keyed by sessionId and we use a distinct sessionId per test
  // to bypass it entirely (matches what Clerk does — every new sign-in
  // mints a new session id).
  const handle = await bootTestDb();
  await handle.db.delete(sessionActivityTable);
});

describe("Session timeout enforcement (HIPAA technical safeguard)", () => {
  it("allows the first authenticated request and upserts session_activity", async () => {
    const handle = await bootTestDb();
    const sessionId = `sess-first-${randomUUID()}`;

    const res = await request(app)
      .get("/api/dashboard/stats")
      .set(withAuth(user.id, sessionId));

    // Either 200 (route exists and authorizes) or 404 (route uri differs)
    // — what matters is that auth passed (NOT 401).
    expect(res.status).not.toBe(401);

    // session_activity row should now exist for this session.
    const [row] = await handle.db
      .select()
      .from(sessionActivityTable)
      .where(eq(sessionActivityTable.sessionId, sessionId))
      .limit(1);
    expect(row).toBeDefined();
    expect(row?.orgId).toBe(org.id);
  });

  it("returns 401 with code=SESSION_TIMEOUT when last_active_at is older than the org timeout", async () => {
    const handle = await bootTestDb();
    const sessionId = `sess-stale-${randomUUID()}`;

    // Establish a session by making one authenticated request.
    const ok = await request(app)
      .get("/api/dashboard/stats")
      .set(withAuth(user.id, sessionId));
    expect(ok.status).not.toBe(401);

    // Verify the row exists, then back-date last_active_at and expires_at
    // to simulate 31 minutes of inactivity (1 minute past the 30-minute
    // timeout configured for this org).
    const thirtyOneMinAgo = new Date(Date.now() - 31 * 60 * 1000);
    const oneMinAgo = new Date(Date.now() - 60 * 1000);
    await handle.db
      .update(sessionActivityTable)
      .set({ lastActiveAt: thirtyOneMinAgo, expiresAt: oneMinAgo })
      .where(eq(sessionActivityTable.sessionId, sessionId));

    // The local in-process cache may still consider this session fresh.
    // Forcing a sync requires either advancing the syncedAt clock past the
    // 60-second window or — what we actually do here — using a brand new
    // sessionId for the staleness check. We've back-dated the row so the
    // DB read path will hit the "already expired in DB" branch and 401.
    //
    // BUT: the cache was populated by the first request above for this
    // very sessionId. We need to flush it. The simplest cross-platform
    // way is to clear the module-level cache via a re-import is not
    // possible (vi.resetModules would re-mock everything). Instead we
    // rely on the fact that the second request will (a) miss the cache
    // sync window only after 60s, OR (b) detect now() > expiresAt
    // because the cache.lastActiveAt comparison still trips the timeout:
    // `now - lastActiveAt > timeoutMs` is also true for the cached value
    // once we update via the DB write below… but the cache holds the
    // ORIGINAL now() not the back-dated value.
    //
    // Workaround: issue the second request with a different sessionId
    // that points to the same stale row. requireAuth re-reads the row
    // by sessionId, sees expires_at in the past, deletes it, returns
    // 401. This mirrors what happens on a process restart (no cache).
    const probeSessionId = `${sessionId}-probe`;
    await handle.db
      .insert(sessionActivityTable)
      .values({
        sessionId: probeSessionId,
        orgId: org.id,
        lastActiveAt: thirtyOneMinAgo,
        expiresAt: oneMinAgo,
      });

    const stale = await request(app)
      .get("/api/dashboard/stats")
      .set(withAuth(user.id, probeSessionId));

    expect(stale.status).toBe(401);
    expect(stale.body).toMatchObject({
      error: expect.stringMatching(/session/i),
      code: "SESSION_TIMEOUT",
    });

    // The expired row must be KEPT. Deleting it would make the next request
    // from the same (dead) session look brand new and let it back in.
    const [kept] = await handle.db
      .select()
      .from(sessionActivityTable)
      .where(eq(sessionActivityTable.sessionId, probeSessionId))
      .limit(1);
    expect(kept).toBeDefined();

    // Trying again with the same expired session is still refused.
    const retry = await request(app)
      .get("/api/dashboard/stats")
      .set(withAuth(user.id, probeSessionId));
    expect(retry.status).toBe(401);
    expect(retry.body).toMatchObject({ code: "SESSION_TIMEOUT" });
  });

  it("a fresh sign-in (new sessionId) works normally after a timeout", async () => {
    const handle = await bootTestDb();
    const expiredSessionId = `sess-expired-${randomUUID()}`;
    const freshSessionId = `sess-fresh-${randomUUID()}`;

    // Pre-seed an expired row and confirm it 401s.
    const past = new Date(Date.now() - 31 * 60 * 1000);
    await handle.db.insert(sessionActivityTable).values({
      sessionId: expiredSessionId,
      orgId: org.id,
      lastActiveAt: past,
      expiresAt: past,
    });
    const dead = await request(app)
      .get("/api/dashboard/stats")
      .set(withAuth(user.id, expiredSessionId));
    expect(dead.status).toBe(401);

    // Same user, brand new session id — should succeed.
    const reborn = await request(app)
      .get("/api/dashboard/stats")
      .set(withAuth(user.id, freshSessionId));
    expect(reborn.status).not.toBe(401);

    // And the new session activity row should be created.
    const [row] = await handle.db
      .select()
      .from(sessionActivityTable)
      .where(eq(sessionActivityTable.sessionId, freshSessionId))
      .limit(1);
    expect(row).toBeDefined();
  });

  it("uses each org's own session_timeout_minutes (per-tenant config respected)", async () => {
    const handle = await bootTestDb();
    // Org B configured for 5 minute timeout; an 8-minute-old session is stale.
    const orgB = await seedOrg(handle.db, { id: "session-timeout-org-b" });
    await handle.db.insert(orgSettingsTable).values({
      id: randomUUID(),
      orgId: orgB.id,
      sessionTimeoutMinutes: 5,
    });
    const userB = await seedUser(handle.db, {
      orgId: orgB.id,
      role: "agency_admin",
    });
    const sid = `sess-orgb-${randomUUID()}`;
    const eightMinAgo = new Date(Date.now() - 8 * 60 * 1000);
    await handle.db.insert(sessionActivityTable).values({
      sessionId: sid,
      orgId: orgB.id,
      lastActiveAt: eightMinAgo,
      expiresAt: eightMinAgo,
    });

    const res = await request(app)
      .get("/api/dashboard/stats")
      .set(withAuth(userB.id, sid));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SESSION_TIMEOUT");
  });
});
