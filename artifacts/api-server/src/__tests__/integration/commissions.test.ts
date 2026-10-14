/**
 * Commissions integration suite (PRs #39 + #41).
 *
 * Drives the schedule + hierarchy CRUD endpoints, the statement upload /
 * parse pipeline, the reconciliation worker (invoked directly to avoid
 * pg-boss in tests), the per-agent breakdown read, the missed-payment
 * nightly cron, and the carrier parser registry.
 *
 * Mirrors the style of automation-rules.test.ts: vi.hoisted-bound mocks
 * for db / auth / jobs, supertest against the real express app, and
 * worker functions imported directly so we can assert side-effects on
 * the in-memory pglite handle.
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

import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  agentCommissionPayoutsTable,
  carriersTable,
  commissionHierarchiesTable,
  commissionLineItemsTable,
  commissionSchedulesTable,
  commissionStatementsTable,
  contactsTable,
  enrollmentsTable,
  missedPaymentAlertsTable,
} from "@workspace/db/schema";
import {
  bootTestDb,
  shutdownTestDb,
  withAuth,
  clearEnqueuedJobs,
} from "../helpers/testApp";
import {
  seedOrg,
  seedUser,
  seedAgent,
  seedContact,
  type TestDb,
} from "../helpers/testDb";
import { parseStatement } from "../../lib/commissionParsers";

import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let reconcileStatement: typeof import("../../workers/reconcileCommissionStatement").reconcileStatement;
let commissionMissedPaymentCheckWorker: typeof import("../../workers/commissionMissedPaymentCheck").commissionMissedPaymentCheckWorker;

let org: { id: string };
let admin: { id: string };
let viewer: { id: string };
let carrier: { id: string };

// ---- Local seed helpers (kept here since only this suite uses them) -----

async function seedCarrier(
  db: TestDb,
  opts: { orgId: string; name?: string },
): Promise<{ id: string; name: string }> {
  const id = `carrier-${randomUUID()}`;
  const name = opts.name ?? "Humana";
  await db.insert(carriersTable).values({
    id,
    orgId: opts.orgId,
    name,
    isActive: true,
  });
  return { id, name };
}

async function insertLineItem(
  db: TestDb,
  opts: {
    statementId: string;
    orgId: string;
    memberId?: string | null;
    commissionAmount: string;
    type?: "initial" | "renewal" | "bonus" | "chargeback";
    periodStart?: string;
    periodEnd?: string;
    contactId?: string | null;
    writingAgentId?: string | null;
    raw?: Record<string, unknown>;
  },
): Promise<{ id: string }> {
  const id = `li-${randomUUID()}`;
  await db.insert(commissionLineItemsTable).values({
    id,
    statementId: opts.statementId,
    orgId: opts.orgId,
    contactId: opts.contactId ?? null,
    memberId: opts.memberId ?? null,
    policyNumber: `POL-${id.slice(-6)}`,
    planType: "MAPD",
    planYear: 2025,
    periodStart: opts.periodStart ?? "2025-01-01",
    periodEnd: opts.periodEnd ?? "2025-01-31",
    premium: "120.00",
    commissionAmount: opts.commissionAmount,
    type: opts.type ?? "initial",
    writingAgentId: opts.writingAgentId ?? null,
    matchStatus: "unmatched",
    raw: opts.raw ?? {},
  });
  return { id };
}

async function insertStatement(
  db: TestDb,
  opts: {
    orgId: string;
    carrierId: string;
    status?: string;
    periodStart?: string;
    periodEnd?: string;
  },
): Promise<{ id: string }> {
  const id = `stmt-${randomUUID()}`;
  await db.insert(commissionStatementsTable).values({
    id,
    orgId: opts.orgId,
    carrierId: opts.carrierId,
    statementDate: "2025-02-01",
    periodStart: opts.periodStart ?? "2025-01-01",
    periodEnd: opts.periodEnd ?? "2025-01-31",
    totalAmount: "1000.00",
    currency: "USD",
    source: "csv_upload",
    storageKey: `commission-statements/${opts.orgId}/${id}/file.csv`,
    status: opts.status ?? "parsed",
    uploadedByUserId: null,
  });
  return { id };
}

// Tiny inline Humana-format CSV: pipe-delimited, headerless, 13 columns.
//   policyNumber|lastName|memberId|firstName|dob|state|planCode|planYear|periodStart|periodEnd|premium|commission|type
const HUMANA_CSV_BUFFER = Buffer.from(
  [
    "POL-100|Smith|MEM-100|Jane|01/15/1955|FL|MAPD|2025|01/01/2025|01/31/2025|120.50|45.00|NEW",
    "POL-101|Doe|MEM-101|John|03/22/1948|TX|MAPD|2025|01/01/2025|01/31/2025|130.00|22.50|RENEWAL",
    // Uses Humana's documented short code CHGBK — toType() now classifies
    // this explicitly as 'chargeback' (fixed alongside this test in the
    // same PR as the bug-fix batch).
    "POL-102|Roe|MEM-102|Mary|07/04/1960|CA|MAPD|2025|01/01/2025|01/31/2025|100.00|-30.00|CHGBK",
  ].join("\n"),
  "utf8",
);

beforeAll(async () => {
  const handle = await bootTestDb();
  app = (await import("../../app")).default;
  request = (await import("supertest") as any).default;
  reconcileStatement = (
    await import("../../workers/reconcileCommissionStatement")
  ).reconcileStatement;
  commissionMissedPaymentCheckWorker = (
    await import("../../workers/commissionMissedPaymentCheck")
  ).commissionMissedPaymentCheckWorker;

  org = await seedOrg(handle.db, { id: "comm-org" });
  admin = await seedUser(handle.db, {
    orgId: org.id,
    role: "agency_admin",
    id: "comm-admin",
  });
  viewer = await seedUser(handle.db, {
    orgId: org.id,
    role: "viewer",
    id: "comm-viewer",
  });
  carrier = await seedCarrier(handle.db, { orgId: org.id, name: "Humana" });
});

afterAll(async () => {
  await shutdownTestDb();
});

beforeEach(() => {
  clearEnqueuedJobs();
});

describe("Commissions integration", () => {
  it("schedule CRUD: create / list / patch / delete (agency_admin)", async () => {
    const create = await request(app)
      .post("/api/commission-schedules")
      .set(withAuth(admin.id))
      .send({
        carrierId: carrier.id,
        planType: "MAPD",
        contractYear: 2025,
        initialPct: 25,
        renewalPct: 12.5,
        effectiveFrom: "2025-01-01",
      });
    expect(create.status).toBe(201);
    const scheduleId = create.body.id;
    expect(scheduleId).toBeDefined();

    const list = await request(app)
      .get("/api/commission-schedules")
      .set(withAuth(admin.id));
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    expect(list.body.find((s: { id: string }) => s.id === scheduleId)).toBeDefined();

    const patch = await request(app)
      .patch(`/api/commission-schedules/${scheduleId}`)
      .set(withAuth(admin.id))
      .send({ status: "archived" });
    expect(patch.status).toBe(200);
    expect(patch.body.status).toBe("archived");

    const del = await request(app)
      .delete(`/api/commission-schedules/${scheduleId}`)
      .set(withAuth(admin.id));
    // PR #49 caught the asymmetry where agency_admin could create / patch
    // but not delete a schedule. Aligned DELETE to commission:update.
    expect(del.status).toBe(204);
  });

  it("rejects viewer on schedule create / delete (RBAC)", async () => {
    const post = await request(app)
      .post("/api/commission-schedules")
      .set(withAuth(viewer.id))
      .send({
        carrierId: carrier.id,
        planType: "MAPD",
        contractYear: 2025,
        initialPct: 25,
        effectiveFrom: "2025-01-01",
      });
    expect(post.status).toBe(403);

    const list = await request(app)
      .get("/api/commission-schedules")
      .set(withAuth(viewer.id));
    // viewer is not in the commission.read matrix
    expect(list.status).toBe(403);
  });

  it("hierarchy CRUD: create writing→upline split, list by writing agent", async () => {
    const handle = await bootTestDb();
    const writing = await seedAgent(handle.db, { orgId: org.id });
    const upline = await seedAgent(handle.db, { orgId: org.id });

    const post = await request(app)
      .post("/api/commission-hierarchies")
      .set(withAuth(admin.id))
      .send({
        writingAgentId: writing.id,
        uplineAgentId: upline.id,
        splitPct: 20,
        effectiveFrom: "2025-01-01",
      });
    expect(post.status).toBe(201);
    expect(post.body.writingAgentId).toBe(writing.id);
    expect(post.body.uplineAgentId).toBe(upline.id);

    const list = await request(app)
      .get(`/api/commission-hierarchies?agentId=${writing.id}`)
      .set(withAuth(admin.id));
    expect(list.status).toBe(200);
    expect(list.body.length).toBe(1);
    expect(list.body[0].uplineAgentId).toBe(upline.id);
  });

  it("statement upload: 201 + commission_statements row with status 'pending'", async () => {
    const handle = await bootTestDb();
    const res = await request(app)
      .post("/api/commissions/statements")
      .set(withAuth(admin.id))
      .field("carrierId", carrier.id)
      .field("statementDate", "2025-02-01")
      .field("periodStart", "2025-01-01")
      .field("periodEnd", "2025-01-31")
      .field("totalAmount", "37.50")
      .attach("file", HUMANA_CSV_BUFFER, "humana.csv");
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();

    const [row] = await handle.db
      .select()
      .from(commissionStatementsTable)
      .where(eq(commissionStatementsTable.id, res.body.id));
    expect(row).toBeDefined();
    expect(row.status).toBe("pending");
    expect(row.carrierId).toBe(carrier.id);
  });

  it("statement parse: inserts line items + flips status to 'parsed'", async () => {
    const handle = await bootTestDb();
    const upload = await request(app)
      .post("/api/commissions/statements")
      .set(withAuth(admin.id))
      .field("carrierId", carrier.id)
      .field("statementDate", "2025-02-01")
      .field("periodStart", "2025-01-01")
      .field("periodEnd", "2025-01-31")
      .attach("file", HUMANA_CSV_BUFFER, "humana.csv");
    expect(upload.status).toBe(201);

    const parse = await request(app)
      .post(`/api/commissions/statements/${upload.body.id}/parse`)
      .set(withAuth(admin.id))
      .attach("file", HUMANA_CSV_BUFFER, "humana.csv");
    expect(parse.status).toBe(200);
    expect(parse.body.inserted).toBe(3);

    const items = await handle.db
      .select()
      .from(commissionLineItemsTable)
      .where(eq(commissionLineItemsTable.statementId, upload.body.id));
    expect(items.length).toBe(3);

    const [stmt] = await handle.db
      .select()
      .from(commissionStatementsTable)
      .where(eq(commissionStatementsTable.id, upload.body.id));
    expect(stmt.status).toBe("parsed");
  });

  it("statement upload with parse=true reads the file in the same request", async () => {
    const handle = await bootTestDb();
    const res = await request(app)
      .post("/api/commissions/statements")
      .set(withAuth(admin.id))
      .field("carrierId", carrier.id)
      .field("statementDate", "2025-02-01")
      .field("periodStart", "2025-01-01")
      .field("periodEnd", "2025-01-31")
      .field("parse", "true")
      .attach("file", HUMANA_CSV_BUFFER, "humana.csv");
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("parsed");
    expect(res.body.parse).toEqual({ inserted: 3 });

    const items = await handle.db
      .select()
      .from(commissionLineItemsTable)
      .where(eq(commissionLineItemsTable.statementId, res.body.id));
    expect(items.length).toBe(3);
    const [stmt] = await handle.db
      .select()
      .from(commissionStatementsTable)
      .where(eq(commissionStatementsTable.id, res.body.id));
    expect(stmt.status).toBe("parsed");
  });

  it("statement upload with parse=true keeps the statement pending and says why when it can't read the file", async () => {
    const handle = await bootTestDb();
    const [noReader] = await handle.db
      .insert(carriersTable)
      .values({ id: randomUUID(), orgId: org.id, name: "Carrier With No Reader" })
      .returning();
    const res = await request(app)
      .post("/api/commissions/statements")
      .set(withAuth(admin.id))
      .field("carrierId", noReader!.id)
      .field("statementDate", "2025-02-01")
      .field("periodStart", "2025-01-01")
      .field("periodEnd", "2025-01-31")
      .field("parse", "true")
      .attach("file", HUMANA_CSV_BUFFER, "x.csv");
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("pending");
    expect(typeof res.body.parse.error).toBe("string");
    const items = await handle.db
      .select()
      .from(commissionLineItemsTable)
      .where(eq(commissionLineItemsTable.statementId, res.body.id));
    expect(items.length).toBe(0);
  });

  it("statement parse: a second parse of an already-read statement is refused and adds no duplicate lines", async () => {
    const handle = await bootTestDb();
    const upload = await request(app)
      .post("/api/commissions/statements")
      .set(withAuth(admin.id))
      .field("carrierId", carrier.id)
      .field("statementDate", "2025-02-01")
      .field("periodStart", "2025-01-01")
      .field("periodEnd", "2025-01-31")
      .field("parse", "true")
      .attach("file", HUMANA_CSV_BUFFER, "humana.csv");
    expect(upload.body.parse).toEqual({ inserted: 3 });

    const again = await request(app)
      .post(`/api/commissions/statements/${upload.body.id}/parse`)
      .set(withAuth(admin.id))
      .attach("file", HUMANA_CSV_BUFFER, "humana.csv");
    expect(again.status).toBe(409);

    const items = await handle.db
      .select()
      .from(commissionLineItemsTable)
      .where(eq(commissionLineItemsTable.statementId, upload.body.id));
    expect(items.length).toBe(3);
  });

  it("statement parse: two simultaneous requests read the statement once", async () => {
    const handle = await bootTestDb();
    const upload = await request(app)
      .post("/api/commissions/statements")
      .set(withAuth(admin.id))
      .field("carrierId", carrier.id)
      .field("statementDate", "2025-02-01")
      .field("periodStart", "2025-01-01")
      .field("periodEnd", "2025-01-31")
      .attach("file", HUMANA_CSV_BUFFER, "humana.csv");
    const send = () =>
      request(app)
        .post(`/api/commissions/statements/${upload.body.id}/parse`)
        .set(withAuth(admin.id))
        .attach("file", HUMANA_CSV_BUFFER, "humana.csv");
    const [a, b] = await Promise.all([send(), send()]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);

    const items = await handle.db
      .select()
      .from(commissionLineItemsTable)
      .where(eq(commissionLineItemsTable.statementId, upload.body.id));
    expect(items.length).toBe(3);
  });

  it("statement parse without a file is refused (the file is not stored)", async () => {
    const upload = await request(app)
      .post("/api/commissions/statements")
      .set(withAuth(admin.id))
      .field("carrierId", carrier.id)
      .field("statementDate", "2025-02-01")
      .field("periodStart", "2025-01-01")
      .field("periodEnd", "2025-01-31")
      .attach("file", HUMANA_CSV_BUFFER, "humana.csv");
    const parse = await request(app)
      .post(`/api/commissions/statements/${upload.body.id}/parse`)
      .set(withAuth(admin.id));
    expect(parse.status).toBe(400);
  });

  it("reconcile worker: happy path matches member_id → contact, populates writing agent, upserts payout", async () => {
    const handle = await bootTestDb();
    const writing = await seedAgent(handle.db, { orgId: org.id });
    const contact = await seedContact(handle.db, {
      orgId: org.id,
      medicareId: "MEM-RECON-1",
    });
    // Assign agent to contact
    await handle.db
      .update(contactsTable)
      .set({ assignedAgentId: writing.id })
      .where(eq(contactsTable.id, contact.id));

    const stmt = await insertStatement(handle.db, {
      orgId: org.id,
      carrierId: carrier.id,
    });
    const li = await insertLineItem(handle.db, {
      statementId: stmt.id,
      orgId: org.id,
      memberId: "MEM-RECON-1",
      commissionAmount: "100.00",
    });

    const result = await reconcileStatement(stmt.id, org.id);
    expect(result.matched).toBe(1);
    expect(result.unmatched).toBe(0);
    expect(result.payouts).toBe(1);

    const [updated] = await handle.db
      .select()
      .from(commissionLineItemsTable)
      .where(eq(commissionLineItemsTable.id, li.id));
    expect(updated.matchStatus).toBe("matched");
    expect(updated.writingAgentId).toBe(writing.id);

    const [payout] = await handle.db
      .select()
      .from(agentCommissionPayoutsTable)
      .where(
        and(
          eq(agentCommissionPayoutsTable.orgId, org.id),
          eq(agentCommissionPayoutsTable.agentId, writing.id),
        ),
      );
    expect(payout).toBeDefined();
    expect(Number(payout.earned)).toBeCloseTo(100.0, 2);
  });

  it("reconcile worker: 80/20 hierarchy split upserts two payout rows", async () => {
    const handle = await bootTestDb();
    const writing = await seedAgent(handle.db, { orgId: org.id });
    const upline = await seedAgent(handle.db, { orgId: org.id });
    const contact = await seedContact(handle.db, {
      orgId: org.id,
      medicareId: "MEM-SPLIT-1",
    });
    await handle.db
      .update(contactsTable)
      .set({ assignedAgentId: writing.id })
      .where(eq(contactsTable.id, contact.id));

    // 20% upline split → writing agent keeps the remaining 80%
    await handle.db.insert(commissionHierarchiesTable).values({
      id: `hier-${randomUUID()}`,
      orgId: org.id,
      writingAgentId: writing.id,
      uplineAgentId: upline.id,
      splitPct: "20",
      effectiveFrom: "2024-01-01",
      effectiveTo: null,
    });

    const stmt = await insertStatement(handle.db, {
      orgId: org.id,
      carrierId: carrier.id,
    });
    await insertLineItem(handle.db, {
      statementId: stmt.id,
      orgId: org.id,
      memberId: "MEM-SPLIT-1",
      commissionAmount: "200.00",
    });

    const result = await reconcileStatement(stmt.id, org.id);
    expect(result.matched).toBe(1);
    expect(result.payouts).toBe(2);

    const payouts = await handle.db
      .select()
      .from(agentCommissionPayoutsTable)
      .where(eq(agentCommissionPayoutsTable.orgId, org.id));
    const writingPayout = payouts.find((p) => p.agentId === writing.id);
    const uplinePayout = payouts.find((p) => p.agentId === upline.id);
    expect(writingPayout).toBeDefined();
    expect(uplinePayout).toBeDefined();
    expect(Number(writingPayout!.earned)).toBeCloseTo(160.0, 2);
    expect(Number(uplinePayout!.earned)).toBeCloseTo(40.0, 2);
  });

  it("reconcile worker: unmatched member_id leaves status 'unmatched' + no payout", async () => {
    const handle = await bootTestDb();
    const stmt = await insertStatement(handle.db, {
      orgId: org.id,
      carrierId: carrier.id,
      periodStart: "2025-03-01",
      periodEnd: "2025-03-31",
    });
    const li = await insertLineItem(handle.db, {
      statementId: stmt.id,
      orgId: org.id,
      memberId: "MEM-NO-SUCH-CONTACT",
      commissionAmount: "75.00",
      periodStart: "2025-03-01",
      periodEnd: "2025-03-31",
    });

    const result = await reconcileStatement(stmt.id, org.id);
    expect(result.matched).toBe(0);
    expect(result.unmatched).toBe(1);
    expect(result.payouts).toBe(0);

    const [updated] = await handle.db
      .select()
      .from(commissionLineItemsTable)
      .where(eq(commissionLineItemsTable.id, li.id));
    expect(updated.matchStatus).toBe("unmatched");
    expect(updated.writingAgentId).toBeNull();

    const payouts = await handle.db
      .select()
      .from(agentCommissionPayoutsTable)
      .where(
        and(
          eq(agentCommissionPayoutsTable.orgId, org.id),
          eq(agentCommissionPayoutsTable.periodStart, "2025-03-01"),
        ),
      );
    expect(payouts.length).toBe(0);
  });

  it("reconcile worker: chargeback line item is matched + recorded with negative earned", async () => {
    const handle = await bootTestDb();
    const writing = await seedAgent(handle.db, { orgId: org.id });
    const contact = await seedContact(handle.db, {
      orgId: org.id,
      medicareId: "MEM-CB-1",
    });
    await handle.db
      .update(contactsTable)
      .set({ assignedAgentId: writing.id })
      .where(eq(contactsTable.id, contact.id));

    const stmt = await insertStatement(handle.db, {
      orgId: org.id,
      carrierId: carrier.id,
      periodStart: "2025-04-01",
      periodEnd: "2025-04-30",
    });
    await insertLineItem(handle.db, {
      statementId: stmt.id,
      orgId: org.id,
      memberId: "MEM-CB-1",
      commissionAmount: "-50.00",
      type: "chargeback",
      periodStart: "2025-04-01",
      periodEnd: "2025-04-30",
    });

    const result = await reconcileStatement(stmt.id, org.id);
    expect(result.matched).toBe(1);
    expect(result.payouts).toBe(1);

    const [payout] = await handle.db
      .select()
      .from(agentCommissionPayoutsTable)
      .where(
        and(
          eq(agentCommissionPayoutsTable.orgId, org.id),
          eq(agentCommissionPayoutsTable.agentId, writing.id),
          eq(agentCommissionPayoutsTable.periodStart, "2025-04-01"),
        ),
      );
    expect(payout).toBeDefined();
    expect(Number(payout.earned)).toBeCloseTo(-50.0, 2);
  });

  it("per-agent breakdown: GET /agents/:id/commissions returns line items + payouts", async () => {
    const handle = await bootTestDb();
    const writing = await seedAgent(handle.db, { orgId: org.id });
    const contact = await seedContact(handle.db, {
      orgId: org.id,
      medicareId: "MEM-BD-1",
    });
    await handle.db
      .update(contactsTable)
      .set({ assignedAgentId: writing.id })
      .where(eq(contactsTable.id, contact.id));

    const stmt = await insertStatement(handle.db, {
      orgId: org.id,
      carrierId: carrier.id,
      periodStart: "2025-05-01",
      periodEnd: "2025-05-31",
    });
    await insertLineItem(handle.db, {
      statementId: stmt.id,
      orgId: org.id,
      memberId: "MEM-BD-1",
      commissionAmount: "60.00",
      periodStart: "2025-05-01",
      periodEnd: "2025-05-31",
    });
    await reconcileStatement(stmt.id, org.id);

    const res = await request(app)
      .get(`/api/agents/${writing.id}/commissions`)
      .set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.lineItems)).toBe(true);
    expect(Array.isArray(res.body.payouts)).toBe(true);
    expect(res.body.lineItems.length).toBeGreaterThanOrEqual(1);
    const payout = res.body.payouts.find(
      (p: { periodStart: string }) => p.periodStart === "2025-05-01",
    );
    expect(payout).toBeDefined();
    expect(Number(payout.earned)).toBeCloseTo(60.0, 2);
  });

  it("missed-payment cron: inserts alert for enrolled contact w/ no recent line item", async () => {
    const handle = await bootTestDb();
    // Use a fresh org so the cron sweep only sees the contact under test
    const isoOrg = await seedOrg(handle.db, { id: `cron-org-${randomUUID()}` });
    const isoCarrier = await seedCarrier(handle.db, { orgId: isoOrg.id });

    // Active commission schedule for that carrier+plan_type
    await handle.db.insert(commissionSchedulesTable).values({
      id: `sched-${randomUUID()}`,
      orgId: isoOrg.id,
      carrierId: isoCarrier.id,
      planType: "MAPD",
      contractYear: 2025,
      flatAmount: "25.00",
      initialPct: null,
      renewalPct: null,
      effectiveFrom: "2025-01-01",
      effectiveTo: null,
      status: "active",
    });

    // Enrolled contact with carrier + plan_type set, no line items at all
    const contact = await seedContact(handle.db, {
      orgId: isoOrg.id,
      status: "enrolled",
    });
    await handle.db
      .update(contactsTable)
      .set({
        currentCarrierId: isoCarrier.id,
        currentPlanType: "MAPD",
        planYear: 2025,
      })
      .where(eq(contactsTable.id, contact.id));
    // The worker reads `enrollments`, not the flattened `contacts.current_*`
    // columns: a carrier pays on an enrollment, so that is what a missing
    // payment is missing against. The contact columns are still set above
    // because they are not dropped yet and other readers still use them.
    await handle.db.insert(enrollmentsTable).values({
      id: `enr-${randomUUID()}`,
      orgId: isoOrg.id,
      contactId: contact.id,
      carrierId: isoCarrier.id,
      planType: "MAPD",
      planYear: 2025,
      effectiveDate: "2025-01-01",
      effectuated: true,
      status: "active",
    });

    await commissionMissedPaymentCheckWorker({ orgId: isoOrg.id });

    const after1 = await handle.db
      .select()
      .from(missedPaymentAlertsTable)
      .where(eq(missedPaymentAlertsTable.orgId, isoOrg.id));
    expect(after1.length).toBe(1);
    expect(after1[0].contactId).toBe(contact.id);
  });

  // Migration 0005 recreates the unique index with NULLS NOT DISTINCT
  // so the cron's `.onConflictDoNothing()` actually fires on the second
  // run even when policy_number is NULL.
  it("missed-payment cron: idempotent on second run", async () => {
    const handle = await bootTestDb();
    const isoOrg = await seedOrg(handle.db, { id: `cron-org-${randomUUID()}` });
    const isoCarrier = await seedCarrier(handle.db, { orgId: isoOrg.id });
    await handle.db.insert(commissionSchedulesTable).values({
      id: `sched-${randomUUID()}`,
      orgId: isoOrg.id,
      carrierId: isoCarrier.id,
      planType: "MAPD",
      contractYear: 2025,
      flatAmount: "25.00",
      effectiveFrom: "2025-01-01",
      status: "active",
    });
    const contact = await seedContact(handle.db, {
      orgId: isoOrg.id,
      status: "enrolled",
    });
    await handle.db
      .update(contactsTable)
      .set({
        currentCarrierId: isoCarrier.id,
        currentPlanType: "MAPD",
        planYear: 2025,
      })
      .where(eq(contactsTable.id, contact.id));
    // The worker reads `enrollments`, not the flattened `contacts.current_*`
    // columns: a carrier pays on an enrollment, so that is what a missing
    // payment is missing against. The contact columns are still set above
    // because they are not dropped yet and other readers still use them.
    await handle.db.insert(enrollmentsTable).values({
      id: `enr-${randomUUID()}`,
      orgId: isoOrg.id,
      contactId: contact.id,
      carrierId: isoCarrier.id,
      planType: "MAPD",
      planYear: 2025,
      effectiveDate: "2025-01-01",
      effectuated: true,
      status: "active",
    });

    await commissionMissedPaymentCheckWorker({ orgId: isoOrg.id });
    await commissionMissedPaymentCheckWorker({ orgId: isoOrg.id });
    const rows = await handle.db
      .select()
      .from(missedPaymentAlertsTable)
      .where(eq(missedPaymentAlertsTable.orgId, isoOrg.id));
    expect(rows.length).toBe(1);
  });

  it("missed-payment cron: a paid MA line item does not mask a missing PDP payment", async () => {
    // The failure this worker was repointed at enrollments to fix. Matching
    // line items on contactId alone means one paid stream silences the alert
    // for the other, and the beneficiary's second commission stays invisible.
    const handle = await bootTestDb();
    const isoOrg = await seedOrg(handle.db, { id: `cron-org-${randomUUID()}` });
    const isoCarrier = await seedCarrier(handle.db, { orgId: isoOrg.id });
    const contact = await seedContact(handle.db, {
      orgId: isoOrg.id,
      status: "enrolled",
    });

    for (const planType of ["MAPD", "PDP"] as const) {
      await handle.db.insert(commissionSchedulesTable).values({
        id: `sched-${randomUUID()}`,
        orgId: isoOrg.id,
        carrierId: isoCarrier.id,
        planType,
        contractYear: 2025,
        flatAmount: "25.00",
        effectiveFrom: "2025-01-01",
        status: "active",
      });
      await handle.db.insert(enrollmentsTable).values({
        id: `enr-${randomUUID()}`,
        orgId: isoOrg.id,
        contactId: contact.id,
        carrierId: isoCarrier.id,
        planType,
        planYear: 2025,
        effectiveDate: "2025-01-01",
        effectuated: true,
        status: "active",
        policyNumber: `POL-${planType}`,
      });
    }

    // The MA stream is paid; the PDP stream is not.
    const stmt = `stmt-${randomUUID()}`;
    await handle.db.insert(commissionStatementsTable).values({
      id: stmt,
      orgId: isoOrg.id,
      carrierId: isoCarrier.id,
      statementDate: "2025-06-30",
      periodStart: "2025-06-01",
      periodEnd: "2025-06-30",
      source: "csv_upload",
      status: "reconciled",
    });
    await handle.db.insert(commissionLineItemsTable).values({
      id: `li-${randomUUID()}`,
      statementId: stmt,
      orgId: isoOrg.id,
      contactId: contact.id,
      policyNumber: "POL-MAPD",
      planType: "MAPD",
      planYear: 2025,
      commissionAmount: "25.00",
      type: "renewal",
    });

    await commissionMissedPaymentCheckWorker({ orgId: isoOrg.id });

    const alerts = await handle.db
      .select()
      .from(missedPaymentAlertsTable)
      .where(eq(missedPaymentAlertsTable.orgId, isoOrg.id));

    // Exactly one alert, and it is the PDP policy — not zero, and not both.
    expect(alerts.length).toBe(1);
    expect(alerts[0].policyNumber).toBe("POL-PDP");
  });

  it("missed-payment cron: an unattributable line item cannot silence both streams", async () => {
    // A line item recording neither policy number nor plan type used to match
    // EVERY enrollment on the contact, so one such row produced zero alerts on
    // a dual-enrolled beneficiary where two were owed — reopening the exact
    // "one paid stream silences the other" failure by way of the safeguard
    // against false alerts.
    const handle = await bootTestDb();
    const isoOrg = await seedOrg(handle.db, { id: `cron-org-${randomUUID()}` });
    const isoCarrier = await seedCarrier(handle.db, { orgId: isoOrg.id });
    const contact = await seedContact(handle.db, {
      orgId: isoOrg.id,
      status: "enrolled",
    });

    for (const planType of ["MAPD", "PDP"] as const) {
      await handle.db.insert(commissionSchedulesTable).values({
        id: `sched-${randomUUID()}`,
        orgId: isoOrg.id,
        carrierId: isoCarrier.id,
        planType,
        contractYear: 2025,
        flatAmount: "25.00",
        effectiveFrom: "2025-01-01",
        status: "active",
      });
      await handle.db.insert(enrollmentsTable).values({
        id: `enr-${randomUUID()}`,
        orgId: isoOrg.id,
        contactId: contact.id,
        carrierId: isoCarrier.id,
        planType,
        planYear: 2025,
        effectiveDate: "2025-01-01",
        effectuated: true,
        status: "active",
        policyNumber: `POL-${planType}`,
      });
    }

    // One line item that names neither the policy nor the plan type.
    const stmt = `stmt-${randomUUID()}`;
    await handle.db.insert(commissionStatementsTable).values({
      id: stmt,
      orgId: isoOrg.id,
      carrierId: isoCarrier.id,
      statementDate: "2025-06-30",
      periodStart: "2025-06-01",
      periodEnd: "2025-06-30",
      source: "csv_upload",
      status: "reconciled",
    });
    await handle.db.insert(commissionLineItemsTable).values({
      id: `li-${randomUUID()}`,
      statementId: stmt,
      orgId: isoOrg.id,
      contactId: contact.id,
      policyNumber: null,
      planType: null,
      commissionAmount: "25.00",
      type: "renewal",
    });

    await commissionMissedPaymentCheckWorker({ orgId: isoOrg.id });

    const alerts = await handle.db
      .select()
      .from(missedPaymentAlertsTable)
      .where(eq(missedPaymentAlertsTable.orgId, isoOrg.id));

    // Both streams remain unattributed, so both are still owed an alert.
    expect(alerts.length).toBe(2);
  });

  it("missed-payment cron: skips contacts the agency has written off", async () => {
    // The 0040 backfill derives enrollment status from the contact's status,
    // and the worker filters these out as well — a `do_not_contact`
    // beneficiary must not generate commission alerts on the first cron run.
    const handle = await bootTestDb();
    const isoOrg = await seedOrg(handle.db, { id: `cron-org-${randomUUID()}` });
    const isoCarrier = await seedCarrier(handle.db, { orgId: isoOrg.id });
    const contact = await seedContact(handle.db, {
      orgId: isoOrg.id,
      status: "do_not_contact",
    });
    await handle.db.insert(commissionSchedulesTable).values({
      id: `sched-${randomUUID()}`,
      orgId: isoOrg.id,
      carrierId: isoCarrier.id,
      planType: "MAPD",
      contractYear: 2025,
      flatAmount: "25.00",
      effectiveFrom: "2025-01-01",
      status: "active",
    });
    await handle.db.insert(enrollmentsTable).values({
      id: `enr-${randomUUID()}`,
      orgId: isoOrg.id,
      contactId: contact.id,
      carrierId: isoCarrier.id,
      planType: "MAPD",
      planYear: 2025,
      effectiveDate: "2025-01-01",
      effectuated: true,
      status: "active",
    });

    await commissionMissedPaymentCheckWorker({ orgId: isoOrg.id });

    const alerts = await handle.db
      .select()
      .from(missedPaymentAlertsTable)
      .where(eq(missedPaymentAlertsTable.orgId, isoOrg.id));
    expect(alerts.length).toBe(0);
  });

  it("CSV parser registry: parseStatement('Humana', buf) emits normalized rows", async () => {
    const rows = parseStatement("Humana", HUMANA_CSV_BUFFER);
    expect(rows.length).toBe(3);
    expect(rows[0].memberId).toBe("MEM-100");
    expect(rows[0].commissionAmount).toBe("45.00");
    expect(rows[0].type).toBe("initial");
    expect(rows[1].type).toBe("renewal");
    expect(rows[2].type).toBe("chargeback");
    // Humana parser maps state code uppercase
    expect(rows[0].contactStateCode).toBe("FL");
    // dob normalized to ISO
    expect(rows[0].contactDob).toBe("1955-01-15");
  });
});
