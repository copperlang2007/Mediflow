/**
 * Sign-in with Google Cloud Identity Platform (ADR 0006).
 *
 * - verifyIdToken against real RS256 signatures (a locally generated key set
 *   stands in for Google's): issuer, audience, expiry, second factor.
 * - Which user a sign-in is (lib/auth/users.ts), including the one-time link
 *   of an account created under Clerk by its verified email.
 * - Provisioning and invitation accept only for a verified email, and only
 *   with the email from the token.
 * - Admin session list / revoke / force-logout on session_activity.
 *
 * Routes use the synthetic identity mock (helpers/testApp); the token tests
 * import the real module.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

const { dbF, authF, jobsF } = vi.hoisted(() => ({
  dbF: async (): Promise<Record<string, unknown>> => {
    const { dbMockFactory } = await import("../helpers/testApp");
    return dbMockFactory();
  },
  authF: async (): Promise<Record<string, unknown>> => {
    const { identityMockFactory } = await import("../helpers/testApp");
    return identityMockFactory();
  },
  jobsF: async (): Promise<Record<string, unknown>> => {
    const { jobsMockFactory } = await import("../helpers/testApp");
    return jobsMockFactory();
  },
}));
vi.mock("@workspace/db", dbF);
vi.mock("../../lib/auth/identity", authF);
vi.mock("../../lib/jobs", jobsF);

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import * as schema from "@workspace/db/schema";
import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser } from "../helpers/testDb";
import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let handle: Awaited<ReturnType<typeof bootTestDb>>;
let identity: typeof import("../../lib/auth/identity");
let users: typeof import("../../lib/auth/users");
let identityAdmin: typeof import("../../lib/auth/admin");

let org: { id: string };
let otherOrg: { id: string };
let admin: { id: string };
let otherAdmin: { id: string };

const PROJECT = "agencyportal-test";

beforeAll(async () => {
  handle = await bootTestDb();
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;
  identity = await vi.importActual<typeof import("../../lib/auth/identity")>("../../lib/auth/identity");
  users = await import("../../lib/auth/users");
  identityAdmin = await import("../../lib/auth/admin");
  org = await seedOrg(handle.db, { id: "idp-org" });
  otherOrg = await seedOrg(handle.db, { id: "idp-other-org" });
  admin = await seedUser(handle.db, { orgId: org.id, role: "agency_admin" });
  otherAdmin = await seedUser(handle.db, { orgId: otherOrg.id, role: "agency_admin" });
});

afterAll(async () => {
  identity.setIdentityKeysForTests(null);
  identityAdmin.setIdentityAdminForTests(null);
  await shutdownTestDb();
});

describe("verifying an Identity Platform ID token", () => {
  let sign: (claims: Record<string, unknown>, opts?: { iss?: string; aud?: string; exp?: number }) => Promise<string>;
  let otherKeyToken: string;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
    identity.setIdentityKeysForTests(createLocalJWKSet({ keys: [jwk] }));
    const now = Math.floor(Date.now() / 1000);
    sign = (claims, opts = {}) =>
      new SignJWT({ auth_time: now - 60, ...claims })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(opts.iss ?? `https://securetoken.google.com/${PROJECT}`)
        .setAudience(opts.aud ?? PROJECT)
        .setSubject("uid-123")
        .setIssuedAt(now - 30)
        .setExpirationTime(opts.exp ?? now + 3600)
        .sign(privateKey);
    const other = await generateKeyPair("RS256");
    otherKeyToken = await new SignJWT({ auth_time: now })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(`https://securetoken.google.com/${PROJECT}`)
      .setAudience(PROJECT)
      .setSubject("uid-123")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(other.privateKey);
  });

  it("accepts a valid token and reads the subject, verified email, second factor and sign-in time", async () => {
    const t = await sign({ email: "Pat@Agency.Example", email_verified: true, firebase: { sign_in_second_factor: "totp" } });
    const auth = await identity.verifyIdToken(t, PROJECT);
    expect(auth).toMatchObject({ subject: "uid-123", email: "pat@agency.example", emailVerified: true, mfa: true });
    expect(auth!.sessionId).toBe(`uid-123:${auth!.sessionClaims!.auth_time}`);
  });

  it("reports no second factor and an unverified email when the token says so", async () => {
    const auth = await identity.verifyIdToken(await sign({ email: "a@b.example", email_verified: false }), PROJECT);
    expect(auth).toMatchObject({ emailVerified: false, mfa: false });
  });

  it("rejects another project's token, a wrong issuer, an expired token and a forged signature", async () => {
    expect(await identity.verifyIdToken(await sign({}, { aud: "someone-else" }), PROJECT)).toBeNull();
    expect(await identity.verifyIdToken(await sign({}, { iss: "https://securetoken.google.com/someone-else" }), PROJECT)).toBeNull();
    expect(await identity.verifyIdToken(await sign({}, { exp: Math.floor(Date.now() / 1000) - 600 }), PROJECT)).toBeNull();
    expect(await identity.verifyIdToken(otherKeyToken, PROJECT)).toBeNull();
    expect(await identity.verifyIdToken("not-a-token", PROJECT)).toBeNull();
  });

  it("reads the token from the Authorization header or the __session cookie; a bad token leaves the request signed out", async () => {
    process.env.IDENTITY_PLATFORM_PROJECT_ID = PROJECT;
    try {
      const run = async (headers: Record<string, string>) => {
        const req = { headers } as unknown as import("express").Request;
        await identity.identityMiddleware()(req, {} as never, () => undefined);
        return identity.getAuth(req);
      };
      const t = await sign({ email: "a@b.example", email_verified: true });
      expect((await run({ authorization: `Bearer ${t}` })).subject).toBe("uid-123");
      expect((await run({ cookie: `theme=dark; __session=${encodeURIComponent(t)}` })).subject).toBe("uid-123");
      expect((await run({ authorization: "Bearer forged" })).subject).toBeNull();
      // A stale cookie from an earlier sign-in next to the current one: the valid one wins.
      const stale = await sign({}, { exp: Math.floor(Date.now() / 1000) - 600 });
      expect((await run({ cookie: `__session=${stale}; __session=${encodeURIComponent(t)}` })).subject).toBe("uid-123");
      expect((await run({})).subject).toBeNull();
    } finally {
      delete process.env.IDENTITY_PLATFORM_PROJECT_ID;
    }
  });

  it("refuses everything when no project is configured", async () => {
    expect(await identity.verifyIdToken(await sign({}), null)).toBeNull();
  });
});

describe("which user a sign-in is", () => {
  const auth = (subject: string, email: string | null, emailVerified = true) => ({
    subject,
    sessionId: `${subject}:1`,
    email,
    emailVerified,
    mfa: true,
    sessionClaims: { iat: 1, auth_time: 1 },
  });

  it("links an account created under Clerk once, by its verified email, and keeps using the link", async () => {
    const legacy = await seedUser(handle.db, { id: `user_${randomUUID()}`, orgId: org.id, email: "Legacy.Person@Agency.Example" });
    const subject = `uid-${randomUUID()}`;
    expect(await users.resolveUserId(auth(subject, "legacy.person@agency.example"))).toBe(legacy.id);
    const [link] = await handle.db.select().from(schema.userIdentitiesTable).where(eq(schema.userIdentitiesTable.subject, subject));
    expect(link).toMatchObject({ provider: "identity_platform", userId: legacy.id, linkedVia: "verified_email" });
    // A second identity with the same email cannot take over the linked account.
    expect(await users.resolveUserId(auth(`uid-${randomUUID()}`, "legacy.person@agency.example"))).toBeNull();
    // The link holds even if the identity's email later changes.
    expect(await users.resolveUserId(auth(subject, "renamed@agency.example"))).toBe(legacy.id);
  });

  it("never links on an unverified email", async () => {
    await seedUser(handle.db, { id: `user_${randomUUID()}`, orgId: org.id, email: "unverified@agency.example" });
    expect(await users.resolveUserId(auth(`uid-${randomUUID()}`, "unverified@agency.example", false))).toBeNull();
  });

  it("does not guess when two earlier accounts share the email", async () => {
    await seedUser(handle.db, { id: `user_${randomUUID()}`, orgId: org.id, email: "shared@agency.example" });
    await seedUser(handle.db, { id: `user_${randomUUID()}`, orgId: otherOrg.id, email: "shared@agency.example" });
    expect(await users.resolveUserId(auth(`uid-${randomUUID()}`, "shared@agency.example"))).toBeNull();
  });

  it("only links accounts created under Clerk, never one created since", async () => {
    await seedUser(handle.db, { id: `uid-${randomUUID()}`, orgId: org.id, email: "newstyle@agency.example" });
    expect(await users.resolveUserId(auth(`uid-${randomUUID()}`, "newstyle@agency.example"))).toBeNull();
  });

  it("matches the Clerk id prefix literally (in LIKE, `_` would match any character)", async () => {
    await seedUser(handle.db, { id: `userX${randomUUID()}`, orgId: org.id, email: "lookalike@agency.example" });
    expect(await users.resolveUserId(auth(`uid-${randomUUID()}`, "lookalike@agency.example"))).toBeNull();
  });

  it("a linked Clerk-era user signs in and uses the app as themselves", async () => {
    const legacy = await seedUser(handle.db, { id: `user_${randomUUID()}`, orgId: org.id, role: "agency_admin", email: "returning@agency.example" });
    const subject = `uid-${randomUUID()}`;
    const res = await request(app)
      .get("/api/auth/status")
      .set({ ...withAuth(subject), "x-test-email": "returning@agency.example" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ provisioned: true, orgId: org.id });
    const me = await request(app).get("/api/users/me").set({ ...withAuth(subject), "x-test-email": "returning@agency.example" });
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(legacy.id);
  });
});

describe("creating an agency and accepting an invitation", () => {
  it("asks for a verified email before creating an agency", async () => {
    const subject = `uid-${randomUUID()}`;
    const res = await request(app)
      .post("/api/auth/provision")
      .set({ ...withAuth(subject), "x-test-email": "new@agency.example", "x-test-email-verified": "false" })
      .send({ fullName: "New Person", orgName: "New Agency" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("EMAIL_NOT_VERIFIED");
    const status = await request(app)
      .get("/api/auth/status")
      .set({ ...withAuth(subject), "x-test-email": "new@agency.example", "x-test-email-verified": "false" });
    expect(status.body).toMatchObject({ provisioned: false, emailVerified: false });
  });

  it("creates the agency with the token's email (not one sent in the request) and links the identity", async () => {
    const subject = `uid-${randomUUID()}`;
    const res = await request(app)
      .post("/api/auth/provision")
      .set({ ...withAuth(subject), "x-test-email": "owner@new-agency.example" })
      .send({ email: "someone-else@evil.example", fullName: "Owner", orgName: "New Agency" });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ id: subject, email: "owner@new-agency.example", role: "agency_admin" });
    const [link] = await handle.db.select().from(schema.userIdentitiesTable).where(eq(schema.userIdentitiesTable.subject, subject));
    expect(link).toMatchObject({ userId: subject, linkedVia: "provision" });
  });

  it("does not create a second agency when the email already has an account it could not be linked to", async () => {
    await seedUser(handle.db, { id: `user_${randomUUID()}`, orgId: org.id, email: "dup@case.example" });
    await seedUser(handle.db, { id: `user_${randomUUID()}`, orgId: otherOrg.id, email: "DUP@case.example" });
    const subject = `uid-${randomUUID()}`;
    const headers = { ...withAuth(subject), "x-test-email": "dup@case.example" };
    expect((await request(app).get("/api/auth/status").set(headers)).body).toMatchObject({ provisioned: false });
    const res = await request(app).post("/api/auth/provision").set(headers).send({ fullName: "Dup", orgName: "Fork" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("account_exists");
    expect(await handle.db.select().from(schema.usersTable).where(eq(schema.usersTable.id, subject))).toHaveLength(0);
  });

  it("two simultaneous sign-ups with one email create one agency, not two", async () => {
    const send = (subject: string) =>
      request(app)
        .post("/api/auth/provision")
        .set({ ...withAuth(subject), "x-test-email": "race@new-agency.example" })
        .send({ fullName: "Racer", orgName: "Race Agency" });
    const results = await Promise.all([send(`uid-${randomUUID()}`), send(`uid-${randomUUID()}`)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const rows = await handle.db
      .select()
      .from(schema.usersTable)
      .where(eq(schema.usersTable.email, "race@new-agency.example"));
    expect(rows).toHaveLength(1);
  });

  it("asks for a verified email before accepting an invitation", async () => {
    const res = await request(app)
      .post("/api/invitations/accept")
      .set({ ...withAuth(`uid-${randomUUID()}`), "x-test-email": "invitee@agency.example", "x-test-email-verified": "false" })
      .send({ token: "x".repeat(43), fullName: "Invitee" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("EMAIL_NOT_VERIFIED");
  });

  it("refuses requests without a sign-in", async () => {
    expect((await request(app).get("/api/auth/status")).status).toBe(401);
    expect((await request(app).post("/api/auth/provision").send({ fullName: "x" })).status).toBe(401);
    expect((await request(app).get("/api/users/me")).status).toBe(401);
  });
});

describe("admin session controls", () => {
  const sessionOf = (subject: string, at: number) => `${subject}:${at}`;
  let target: { id: string };

  beforeEach(async () => {
    target = await seedUser(handle.db, { orgId: org.id, role: "agent" });
  });

  async function signIn(sessionId: string) {
    return request(app).get("/api/users/me").set(withAuth(target.id, sessionId));
  }

  it("lists a user's live sessions, revokes one, and the revoked one is refused", async () => {
    const s1 = sessionOf(target.id, 1_800_000_000);
    const s2 = sessionOf(target.id, 1_800_000_100);
    expect((await signIn(s1)).status).toBe(200);
    expect((await signIn(s2)).status).toBe(200);

    const list = await request(app).get(`/api/admin/users/${target.id}/sessions`).set(withAuth(admin.id));
    expect(list.status).toBe(200);
    expect(list.body.map((s: { sessionId: string }) => s.sessionId).sort()).toEqual([s1, s2].sort());
    expect(list.body.find((s: { sessionId: string }) => s.sessionId === s1).createdAt).toBe(new Date(1_800_000_000 * 1000).toISOString());

    const del = await request(app).delete(`/api/admin/sessions/${encodeURIComponent(s1)}`).set(withAuth(admin.id));
    expect(del.status).toBe(200);
    const refused = await signIn(s1);
    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe("SESSION_TIMEOUT");
    expect((await signIn(s2)).status).toBe(200);

    const [audit] = await handle.db
      .select()
      .from(schema.auditLogTable)
      .where(and(eq(schema.auditLogTable.action, "revoke_session"), eq(schema.auditLogTable.resourceId, s1)));
    expect(audit?.changes).toMatchObject({ targetUserId: target.id });
  });

  it("a session ended on another server stays ended, even while this server remembers it as active", async () => {
    const s = sessionOf(target.id, 1_800_000_600);
    expect((await signIn(s)).status).toBe(200);
    // Another instance ends it (admin revoke): only the row changes, this instance's cache is still warm.
    await handle.db
      .update(schema.sessionActivityTable)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.sessionActivityTable.sessionId, s));
    const refused = await signIn(s);
    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe("SESSION_TIMEOUT");
    const [row] = await handle.db.select().from(schema.sessionActivityTable).where(eq(schema.sessionActivityTable.sessionId, s));
    expect(row!.expiresAt.getTime()).toBeLessThan(Date.now());
  });

  it("a busy session is re-read from the database about once a minute, not on every request", async () => {
    const s = sessionOf(target.id, 1_800_000_660);
    const t0 = Date.now();
    const spy = vi.spyOn(Date, "now");
    try {
      spy.mockReturnValue(t0);
      expect((await signIn(s)).status).toBe(200);
      spy.mockReturnValue(t0 + 70_000); // past the 60 s window: re-reads the row
      expect((await signIn(s)).status).toBe(200);
      // Make the row say "idle for 2 hours"; a request served from the fresh cache does not see it yet.
      await handle.db
        .update(schema.sessionActivityTable)
        .set({ lastActiveAt: new Date(t0 - 2 * 60 * 60 * 1000) })
        .where(eq(schema.sessionActivityTable.sessionId, s));
      spy.mockReturnValue(t0 + 80_000);
      expect((await signIn(s)).status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });

  it("a revoked session's row is kept as ended (not epoch), so cleanup keeps it for the full retention window", async () => {
    const s = sessionOf(target.id, 1_800_000_700);
    await signIn(s);
    const before = Date.now();
    await request(app).delete(`/api/admin/sessions/${encodeURIComponent(s)}`).set(withAuth(admin.id));
    const [row] = await handle.db.select().from(schema.sessionActivityTable).where(eq(schema.sessionActivityTable.sessionId, s));
    expect(row!.expiresAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("refuses a sign-in older than the retention window: no row could still prove it was not ended", async () => {
    const { SESSION_RETENTION_MS } = await import("../../middlewares/requireAuth");
    const old = Math.floor((Date.now() - SESSION_RETENTION_MS) / 1000) - 60;
    const res = await request(app)
      .get("/api/users/me")
      .set({ ...withAuth(target.id, sessionOf(target.id, old)), "x-test-auth-time": String(old) });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SESSION_TIMEOUT");
    const recent = Math.floor(Date.now() / 1000) - 3600;
    const ok = await request(app)
      .get("/api/users/me")
      .set({ ...withAuth(target.id, sessionOf(target.id, recent)), "x-test-auth-time": String(recent) });
    expect(ok.status).toBe(200);
  });

  it("another agency's admin can neither list nor revoke them", async () => {
    const s = sessionOf(target.id, 1_800_000_200);
    await signIn(s);
    expect((await request(app).get(`/api/admin/users/${target.id}/sessions`).set(withAuth(otherAdmin.id))).status).toBe(404);
    expect((await request(app).delete(`/api/admin/sessions/${encodeURIComponent(s)}`).set(withAuth(otherAdmin.id))).status).toBe(404);
    expect((await signIn(s)).status).toBe(200);
  });

  it("force-logout ends every session and cancels the stored sign-ins at Identity Platform", async () => {
    const calls: Array<{ url: string; data: unknown }> = [];
    identityAdmin.setIdentityAdminForTests(async (r) => void calls.push({ url: r.url, data: r.data }));
    process.env.IDENTITY_PLATFORM_PROJECT_ID = PROJECT;
    try {
      const s1 = sessionOf(target.id, 1_800_000_300);
      const s2 = sessionOf(target.id, 1_800_000_400);
      await signIn(s1);
      await signIn(s2);
      const res = await request(app).post(`/api/admin/users/${target.id}/force-logout`).set(withAuth(admin.id));
      expect(res.status).toBe(200);
      expect(res.body.revokedCount).toBe(2);
      expect((await signIn(s1)).status).toBe(401);
      expect((await signIn(s2)).status).toBe(401);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:update`);
      expect(calls[0]!.data).toMatchObject({ localId: target.id });
      // A brand-new sign-in still works: force-logout is not deactivation.
      expect((await signIn(sessionOf(target.id, 1_800_000_500))).status).toBe(200);
    } finally {
      delete process.env.IDENTITY_PLATFORM_PROJECT_ID;
      identityAdmin.setIdentityAdminForTests(null);
    }
  });
});
