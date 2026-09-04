/**
 * Team invitations and seat accounting.
 *
 * Before this feature an organization could only ever contain the one user who
 * created it — every Clerk sign-up ran `POST /auth/provision`, which minted a
 * fresh org unconditionally. The properties worth pinning are therefore the
 * ones that make an agency a *shared* workspace, plus the arithmetic the
 * per-seat invoice depends on:
 *
 *   - an invited person lands in the inviting org, not a new one
 *   - a pending invitation holds a seat, so the plan limit fails on the admin
 *     (who can act) rather than on the invitee (who cannot)
 *   - revoking and deactivating give the seat back
 *   - an invitation is single-use, expires, and is not reachable cross-tenant
 *   - the raw token never appears in any response but the one that mints it
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

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

import { eq, inArray, notInArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  userInvitationsTable,
  usersTable,
  subscriptionsTable,
} from "@workspace/db/schema";
import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser, type TestDb } from "../helpers/testDb";

import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let testDb: TestDb;

let orgA: { id: string };
let orgB: { id: string };
let adminA: { id: string };
let adminB: { id: string };

/**
 * Imported lazily: `entitlements` pulls in `@workspace/db`, and the mock
 * factory refuses to resolve before `bootTestDb()` has stood up pglite.
 */
let resetEntitlementsCacheForTests: () => void;

/**
 * Sets the org's purchased seats.
 *
 * `STRIPE_SECRET_KEY` has to be present for entitlements to consult the
 * subscription at all — an unconfigured deployment deliberately grants the top
 * tier so demo installs are not crippled, which would make every seat limit
 * here unreachable.
 */
async function setSeats(orgId: string, seats: number): Promise<void> {
  await testDb
    .insert(subscriptionsTable)
    .values({
      id: `sub-${orgId}`,
      orgId,
      planTier: "growth",
      status: "active",
      seats,
    })
    .onConflictDoUpdate({
      target: subscriptionsTable.orgId,
      set: { seats, status: "active", planTier: "growth" },
    });
  resetEntitlementsCacheForTests();
}

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_seats";
  const handle = await bootTestDb();
  ({ resetEntitlementsCacheForTests } = await import(
    "../../lib/billing/entitlements"
  ));
  testDb = handle.db;
  app = (await import("../../app")).default;
  request = (await import("supertest")).default;

  orgA = await seedOrg(testDb, { name: "Alpha Agency" });
  orgB = await seedOrg(testDb, { name: "Beta Agency" });
  adminA = await seedUser(testDb, {
    orgId: orgA.id,
    role: "agency_admin",
    email: "admin-a@alpha.test",
    fullName: "Ada Admin",
  });
  adminB = await seedUser(testDb, {
    orgId: orgB.id,
    role: "agency_admin",
    email: "admin-b@beta.test",
  });
});

afterAll(async () => {
  delete process.env.STRIPE_SECRET_KEY;
  await shutdownTestDb();
});

beforeEach(async () => {
  await testDb.delete(userInvitationsTable);
  // Seat arithmetic is a whole-org count, so members created by an earlier
  // test would silently change the limit every later test is asserting
  // against. Reset each org to exactly its admin.
  await testDb
    .delete(usersTable)
    .where(notInArray(usersTable.id, [adminA.id, adminB.id]));
  await testDb
    .update(usersTable)
    .set({ isActive: true })
    .where(inArray(usersTable.id, [adminA.id, adminB.id]));
  // Roomy by default; individual tests tighten it.
  await setSeats(orgA.id, 10);
  await setSeats(orgB.id, 10);
});

function invite(
  as: { id: string },
  body: Record<string, unknown>,
): ReturnType<ReturnType<typeof request>["post"]> {
  return request(app).post("/api/invitations").set(withAuth(as.id)).send(body);
}

describe("invitation lifecycle", () => {
  it("puts the invited person in the inviting org, not a new one", async () => {
    const created = await invite(adminA, {
      email: "New.Hire@alpha.test",
      role: "compliance_manager",
    });
    expect(created.status).toBe(201);

    const url = new URL(created.body.acceptUrl);
    const token = url.searchParams.get("token");
    expect(token).toBeTruthy();

    // The recipient can see what they were invited to before signing up.
    const preview = await request(app).get(
      `/api/invitations/lookup?token=${encodeURIComponent(token!)}`,
    );
    expect(preview.status).toBe(200);
    expect(preview.body.organizationName).toBe("Alpha Agency");
    expect(preview.body.role).toBe("compliance_manager");

    const newClerkId = `clerk-${randomUUID()}`;
    const accepted = await request(app)
      .post("/api/invitations/accept")
      .set(withAuth(newClerkId))
      .send({ token, fullName: "Nora Newhire" });

    expect(accepted.status).toBe(201);
    expect(accepted.body.user.orgId).toBe(orgA.id);
    expect(accepted.body.user.role).toBe("compliance_manager");
    // Address comes from the invitation, normalized — not from the accepter.
    expect(accepted.body.user.email).toBe("new.hire@alpha.test");
  });

  it("is single-use", async () => {
    const created = await invite(adminA, { email: "once@alpha.test" });
    const token = new URL(created.body.acceptUrl).searchParams.get("token")!;

    const first = await request(app)
      .post("/api/invitations/accept")
      .set(withAuth(`clerk-${randomUUID()}`))
      .send({ token, fullName: "First Arrival" });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/api/invitations/accept")
      .set(withAuth(`clerk-${randomUUID()}`))
      .send({ token, fullName: "Second Arrival" });
    expect(second.status).toBe(410);
    expect(second.body.code).toBe("accepted");
  });

  it("refuses an expired invitation even before the sweep marks it", async () => {
    const created = await invite(adminA, { email: "stale@alpha.test" });
    const token = new URL(created.body.acceptUrl).searchParams.get("token")!;

    // Backdate the expiry, leaving status 'pending' — this is exactly the
    // state a row sits in between lapsing and anyone reading the list.
    await testDb
      .update(userInvitationsTable)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(userInvitationsTable.id, created.body.invitation.id));

    const accepted = await request(app)
      .post("/api/invitations/accept")
      .set(withAuth(`clerk-${randomUUID()}`))
      .send({ token, fullName: "Too Late" });

    expect(accepted.status).toBe(410);
    expect(accepted.body.code).toBe("expired");
  });

  it("never returns the raw token after creation", async () => {
    const created = await invite(adminA, { email: "secret@alpha.test" });
    const rawToken = new URL(created.body.acceptUrl).searchParams.get("token")!;

    const list = await request(app)
      .get("/api/invitations")
      .set(withAuth(adminA.id));

    const body = JSON.stringify(list.body);
    expect(body).not.toContain(rawToken);
    expect(body).not.toContain("tokenHash");
    expect(body).not.toContain("token_hash");
  });

  it("will not mint a super_admin from a link in an inbox", async () => {
    const res = await invite(adminA, {
      email: "escalate@alpha.test",
      role: "super_admin",
    });
    expect(res.status).toBe(400);
  });

  it("rejects a second pending invitation for the same address", async () => {
    expect((await invite(adminA, { email: "dupe@alpha.test" })).status).toBe(201);
    const second = await invite(adminA, { email: "dupe@alpha.test" });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("invitation_pending");
  });

  it("refuses to invite someone who is already a member", async () => {
    const res = await invite(adminA, { email: "admin-a@alpha.test" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("already_member");
  });
});

describe("seat accounting", () => {
  it("counts a pending invitation against the plan, so the admin hits the wall", async () => {
    // One seat, already taken by adminA.
    await setSeats(orgA.id, 1);

    const res = await invite(adminA, { email: "nope@alpha.test" });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe("plan_limit_exceeded");
  });

  it("reserves the seat at invite time rather than at accept time", async () => {
    await setSeats(orgA.id, 2); // adminA + exactly one more

    expect((await invite(adminA, { email: "first@alpha.test" })).status).toBe(201);

    // The second invite must fail HERE — not silently succeed and strand the
    // invitee at the accept screen with nothing they can do about it.
    const second = await invite(adminA, { email: "second@alpha.test" });
    expect(second.status).toBe(402);
  });

  it("gives the seat back when an invitation is revoked", async () => {
    await setSeats(orgA.id, 2);

    const created = await invite(adminA, { email: "revokeme@alpha.test" });
    expect(created.body.seats.available).toBe(0);

    const revoked = await request(app)
      .delete(`/api/invitations/${created.body.invitation.id}`)
      .set(withAuth(adminA.id));

    expect(revoked.status).toBe(200);
    expect(revoked.body.seats.available).toBe(1);

    // And the freed seat is genuinely usable.
    expect((await invite(adminA, { email: "next@alpha.test" })).status).toBe(201);
  });

  it("does not let an expired invitation keep holding a seat", async () => {
    await setSeats(orgA.id, 2);

    const created = await invite(adminA, { email: "lapsed@alpha.test" });
    await testDb
      .update(userInvitationsTable)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(userInvitationsTable.id, created.body.invitation.id));

    const res = await invite(adminA, { email: "someone-else@alpha.test" });
    expect(res.status).toBe(201);
  });

  it("re-checks the seat at accept time, so a downgrade is not bypassed", async () => {
    await setSeats(orgA.id, 5);
    const created = await invite(adminA, { email: "downgraded@alpha.test" });
    const token = new URL(created.body.acceptUrl).searchParams.get("token")!;

    // The org shrinks its plan after the link goes out.
    await setSeats(orgA.id, 1);

    const accepted = await request(app)
      .post("/api/invitations/accept")
      .set(withAuth(`clerk-${randomUUID()}`))
      .send({ token, fullName: "Late Joiner" });

    expect(accepted.status).toBe(402);
  });
});

describe("resend", () => {
  it("does not let a lapsed invitation be revived past the seat limit", async () => {
    await setSeats(orgA.id, 2); // adminA + one

    const created = await invite(adminA, { email: "lapsed@alpha.test" });
    expect(created.status).toBe(201);

    // It expires, giving the seat back...
    await testDb
      .update(userInvitationsTable)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(userInvitationsTable.id, created.body.invitation.id));

    // ...and the agency spends it on someone else.
    expect((await invite(adminA, { email: "took-it@alpha.test" })).status).toBe(201);

    // Reviving the lapsed one would now put the org over its plan.
    const resent = await request(app)
      .post(`/api/invitations/${created.body.invitation.id}/resend`)
      .set(withAuth(adminA.id))
      .send({});

    expect(resent.status).toBe(402);
  });

  it("resends a still-live invitation without double-counting its seat", async () => {
    await setSeats(orgA.id, 2); // adminA + exactly one

    const created = await invite(adminA, { email: "nudge@alpha.test" });
    expect(created.body.seats.available).toBe(0);

    // The invitation already holds the last seat; resending must not be read
    // as a request for a second one.
    const resent = await request(app)
      .post(`/api/invitations/${created.body.invitation.id}/resend`)
      .set(withAuth(adminA.id))
      .send({});

    expect(resent.status).toBe(200);
    // A fresh token, and the old one is dead.
    const oldToken = new URL(created.body.acceptUrl).searchParams.get("token")!;
    const newToken = new URL(resent.body.acceptUrl).searchParams.get("token")!;
    expect(newToken).not.toBe(oldToken);

    const stale = await request(app).get(
      `/api/invitations/lookup?token=${encodeURIComponent(oldToken)}`,
    );
    expect(stale.status).toBe(404);
  });
});

describe("deactivation frees a seat", () => {
  it("deactivates, frees the seat, and refuses to reactivate past the limit", async () => {
    const member = await seedUser(testDb, {
      orgId: orgA.id,
      role: "agent",
      email: `member-${randomUUID()}@alpha.test`,
    });
    await setSeats(orgA.id, 2); // adminA + member = full

    expect((await invite(adminA, { email: "waiting@alpha.test" })).status).toBe(402);

    const off = await request(app)
      .patch(`/api/users/${member.id}/active`)
      .set(withAuth(adminA.id))
      .send({ isActive: false });
    expect(off.status).toBe(200);
    expect(off.body.seats.activeUsers).toBe(1);

    // The freed seat is spendable...
    const invited = await invite(adminA, { email: "waiting@alpha.test" });
    expect(invited.status).toBe(201);

    // ...and now reactivating that member would exceed the plan.
    const on = await request(app)
      .patch(`/api/users/${member.id}/active`)
      .set(withAuth(adminA.id))
      .send({ isActive: true });
    expect(on.status).toBe(402);
  });

  it("will not let an admin lock themselves out", async () => {
    const res = await request(app)
      .patch(`/api/users/${adminA.id}/active`)
      .set(withAuth(adminA.id))
      .send({ isActive: false });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("self_deactivation");
  });

  it("re-asserting an already-active state does not consume a seat", async () => {
    const member = await seedUser(testDb, {
      orgId: orgA.id,
      role: "agent",
      email: `idem-${randomUUID()}@alpha.test`,
    });
    await setSeats(orgA.id, 2); // exactly full

    const res = await request(app)
      .patch(`/api/users/${member.id}/active`)
      .set(withAuth(adminA.id))
      .send({ isActive: true });

    expect(res.status).toBe(200);
  });
});

describe("deployment configuration", () => {
  it("refuses to issue an invitation it cannot build a working link for", async () => {
    const prevNodeEnv = process.env.NODE_ENV;
    const prevBase = process.env.APP_BASE_URL;
    process.env.NODE_ENV = "production";
    delete process.env.APP_BASE_URL;

    try {
      const res = await invite(adminA, { email: "deadlink@alpha.test" });

      expect(res.status).toBe(503);
      expect(res.body.code).toBe("app_base_url_unconfigured");

      // And crucially: no invitation row, so no seat was consumed by an
      // invitation whose link would have pointed at the recipient's own
      // machine.
      const rows = await testDb.select().from(userInvitationsTable);
      expect(rows).toHaveLength(0);
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
      if (prevBase === undefined) delete process.env.APP_BASE_URL;
      else process.env.APP_BASE_URL = prevBase;
    }
  });

  it("uses the configured base url for the accept link", async () => {
    const prevBase = process.env.APP_BASE_URL;
    process.env.APP_BASE_URL = "https://app.mediflow.test/";

    try {
      const res = await invite(adminA, { email: "linked@alpha.test" });
      expect(res.status).toBe(201);
      // Trailing slash normalized, not doubled.
      expect(res.body.acceptUrl).toMatch(
        /^https:\/\/app\.mediflow\.test\/accept-invite\?token=/,
      );
    } finally {
      if (prevBase === undefined) delete process.env.APP_BASE_URL;
      else process.env.APP_BASE_URL = prevBase;
    }
  });
});

describe("tenancy", () => {
  it("does not expose another org's invitations", async () => {
    await invite(adminA, { email: "alpha-only@alpha.test" });

    const list = await request(app)
      .get("/api/invitations")
      .set(withAuth(adminB.id));

    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(0);
  });

  it("does not let another org revoke an invitation", async () => {
    const created = await invite(adminA, { email: "protected@alpha.test" });

    const res = await request(app)
      .delete(`/api/invitations/${created.body.invitation.id}`)
      .set(withAuth(adminB.id));

    expect(res.status).toBe(404);

    const [row] = await testDb
      .select()
      .from(userInvitationsTable)
      .where(eq(userInvitationsTable.id, created.body.invitation.id));
    expect(row.status).toBe("pending");
  });

  it("refuses to provision a new org for someone who has a pending invitation", async () => {
    await invite(adminA, { email: "invited-elsewhere@alpha.test" });

    const res = await request(app)
      .post("/api/auth/provision")
      .set(withAuth(`clerk-${randomUUID()}`))
      .send({
        email: "Invited-Elsewhere@alpha.test",
        fullName: "Confused Signup",
        orgName: "Accidental Agency",
      });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("invitation_pending");
  });

  it("refuses to accept into a second org when already provisioned", async () => {
    const created = await invite(adminA, { email: "poacher@alpha.test" });
    const token = new URL(created.body.acceptUrl).searchParams.get("token")!;

    const res = await request(app)
      .post("/api/invitations/accept")
      .set(withAuth(adminB.id))
      .send({ token, fullName: "Already Elsewhere" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("already_provisioned");

    const [stillB] = await testDb
      .select({ orgId: usersTable.orgId })
      .from(usersTable)
      .where(eq(usersTable.id, adminB.id));
    expect(stillB.orgId).toBe(orgB.id);
  });
});
