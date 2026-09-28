/**
 * Phase 4 — real preclearance (spec §2, §9).
 *
 * Exit criterion: "A non-licensed/non-consented dial is blocked and audited."
 *
 * These tests drive `DialerIssuanceService` with the REAL `runPreclearance`
 * (no `preclear` override) against a pglite-backed db, asserting that:
 *   - a fully eligible+consented dial is precleared and the ticket is posted;
 *   - a non-licensed agent is blocked + audited (no outbound call);
 *   - a non-consented (do_not_contact) contact is blocked + audited;
 *   - a DNC (opt-out row) contact is blocked;
 *   - an outside-calling-hours dial is blocked;
 *   - missing AHIP blocks a MAPD dial.
 *
 * The dialer HTTP client is a capturing mock — a precleared dial records one
 * POST, a blocked dial records none.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";

// issuance.ts statically imports `@workspace/db`, whose module-load guard
// requires DATABASE_URL. This suite injects a pglite handle into the service
// and never queries the real node-postgres pool, so a dummy URL satisfies the
// guard. `vi.hoisted` runs before the static imports below.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
});
import { and, eq } from "drizzle-orm";
import {
  setupTestDb,
  teardownTestDb,
  seedOrg,
  seedAgent,
  seedContact,
  type TestDbHandle,
  type TestDb,
} from "../helpers/testDb";
import * as schema from "@workspace/db/schema";
import {
  DialerIssuanceService,
  type HttpClient,
  type IssueTicketInput,
} from "../../lib/dialer/issuance";

function makeKeypair(): { privateKey: string } {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { privateKey };
}

interface Captured {
  url: string;
  body: string;
}

function mockDialer(captured: Captured[]): HttpClient {
  return async (url, init) => {
    captured.push({ url, body: init.body });
    return {
      status: 201,
      json: async () => ({ dialerTicketId: "dlr_1", status: "QUEUED" }),
    };
  };
}

let handle: TestDbHandle;
let db: TestDb;

beforeAll(async () => {
  handle = await setupTestDb();
  db = handle.db;
});

afterAll(async () => {
  await teardownTestDb(handle);
});

// A fixed instant that is comfortably inside calling hours in Oregon
// (Pacific): 2026-06-02T18:00:00Z == 11:00 local PDT.
const MIDDAY_UTC = Date.UTC(2026, 5, 2, 18, 0, 0);
// 2026-06-02T06:00:00Z == 23:00 (11pm) PDT — outside the 08:00–21:00 window.
const LATE_NIGHT_UTC = Date.UTC(2026, 5, 2, 6, 0, 0);
const PLAN_YEAR = 2026;

interface Fixture {
  orgId: string;
  agentId: string;
  contactId: string;
}

async function seedEligibleFixture(opts: {
  withLicense?: boolean;
  withAhip?: boolean;
  withCert?: boolean;
  contactStatus?: schema.Contact["status"];
  optOutPhone?: string;
  phone?: string;
}): Promise<Fixture> {
  const org = await seedOrg(db, { id: `org-${randomUUID().slice(0, 8)}` });
  const agent = await seedAgent(db, { orgId: org.id });
  const phone = opts.phone ?? "+15035551234";
  const contact = await seedContact(db, {
    orgId: org.id,
    status: opts.contactStatus ?? "lead",
  });
  // seedContact does not set phone/state; patch them in.
  await db
    .update(schema.contactsTable)
    .set({ phone, stateCode: "OR" })
    .where(eq(schema.contactsTable.id, contact.id));

  if (opts.withLicense ?? true) {
    await db.insert(schema.stateLicensesTable).values({
      id: randomUUID(),
      agentId: agent.id,
      stateCode: "OR",
      licenseType: "health",
      status: "active",
      expiryDate: new Date(Date.UTC(2027, 0, 1)),
    });
  }
  if (opts.withAhip ?? true) {
    await db.insert(schema.ahipRecordsTable).values({
      id: randomUUID(),
      agentId: agent.id,
      certificationYear: PLAN_YEAR,
      status: "passed",
    });
  }
  if (opts.withCert ?? true) {
    const [carrier] = await db
      .insert(schema.carriersTable)
      .values({ id: randomUUID(), orgId: org.id, name: "Acme Health" })
      .returning();
    await db.insert(schema.carrierCertificationsTable).values({
      id: randomUUID(),
      agentId: agent.id,
      carrierId: carrier.id,
      certificationYear: PLAN_YEAR,
      status: "passed",
    });
  }
  if (opts.optOutPhone) {
    await db.insert(schema.optOutsTable).values({
      id: randomUUID(),
      orgId: org.id,
      phone: opts.optOutPhone,
      channel: "sms",
    });
  }

  return { orgId: org.id, agentId: agent.id, contactId: contact.id };
}

function makeService(captured: Captured[], nowMs: number): DialerIssuanceService {
  return new DialerIssuanceService({
    dialerBaseUrl: "https://dialer.internal",
    signingPrivateKey: makeKeypair().privateKey,
    httpClient: mockDialer(captured),
    db,
    nowMs: () => nowMs,
  });
}

function makeInput(f: Fixture): IssueTicketInput {
  return {
    orgId: f.orgId,
    agentId: f.agentId,
    contactRef: f.contactId,
    callee: {
      firstName: "Jane",
      lastName: "Doe",
      phone: "+15035551234",
      stateCode: "OR",
      zipCode: "97201",
    },
    productLine: "MAPD",
    planYear: PLAN_YEAR,
    callbackUrl: "https://app.mediflow.test/api/dialer/v1/events",
  };
}

async function auditRows(
  orgId: string,
  preclearanceId: string,
): Promise<(typeof schema.auditLogTable.$inferSelect)[]> {
  return db
    .select()
    .from(schema.auditLogTable)
    .where(
      and(
        eq(schema.auditLogTable.orgId, orgId),
        eq(schema.auditLogTable.resourceType, "dial_preclearance"),
        eq(schema.auditLogTable.resourceId, preclearanceId),
      ),
    );
}

describe("Phase 4 preclearance — eligibility + consent (exit criterion)", () => {
  let captured: Captured[];
  beforeEach(() => {
    captured = [];
  });

  it("preclears + posts a ticket for a fully eligible, consented, in-hours dial", async () => {
    const f = await seedEligibleFixture({});
    const svc = makeService(captured, MIDDAY_UTC);
    const result = await svc.issueTicket(makeInput(f));

    expect(result.precleared).toBe(true);
    expect(result.status).toBe(201);
    expect(captured).toHaveLength(1); // ticket posted to the dialer

    // Successful issuance is audited too.
    const rows = await auditRows(f.orgId, result.payload.compliance.preclearanceId);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("create");
    expect(
      (rows[0].changes as Record<string, unknown>).precleared,
    ).toBe(true);
  });

  it("BLOCKS + audits a non-licensed dial (no outbound call)", async () => {
    const f = await seedEligibleFixture({ withLicense: false });
    const svc = makeService(captured, MIDDAY_UTC);
    const result = await svc.issueTicket(makeInput(f));

    expect(result.precleared).toBe(false);
    expect(captured).toHaveLength(0); // dialer never contacted

    const rows = await auditRows(f.orgId, result.payload.compliance.preclearanceId);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("block");
    const failures = (rows[0].changes as Record<string, unknown>)
      .failures as Array<{ code: string }>;
    expect(failures.map((x) => x.code)).toContain("AGENT_NOT_LICENSED");
  });

  it("BLOCKS + audits a non-consented (do_not_contact) dial", async () => {
    const f = await seedEligibleFixture({ contactStatus: "do_not_contact" });
    const svc = makeService(captured, MIDDAY_UTC);
    const result = await svc.issueTicket(makeInput(f));

    expect(result.precleared).toBe(false);
    expect(captured).toHaveLength(0);

    const rows = await auditRows(f.orgId, result.payload.compliance.preclearanceId);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("block");
    const failures = (rows[0].changes as Record<string, unknown>)
      .failures as Array<{ code: string }>;
    expect(failures.map((x) => x.code)).toContain("DNC");
  });

  it("BLOCKS a DNC / opt-out contact", async () => {
    const f = await seedEligibleFixture({ optOutPhone: "+15035551234" });
    const svc = makeService(captured, MIDDAY_UTC);
    const result = await svc.issueTicket(makeInput(f));

    expect(result.precleared).toBe(false);
    expect(result.payload.compliance.dncClear).toBe(false);
    expect(captured).toHaveLength(0);
  });

  it("BLOCKS an opt-out stored in E.164 when the callee number is formatted", async () => {
    const f = await seedEligibleFixture({ optOutPhone: "+15035551234" });
    const svc = makeService(captured, MIDDAY_UTC);
    const input = makeInput(f);
    const result = await svc.issueTicket({ ...input, callee: { ...input.callee, phone: "(503) 555-1234" } });

    expect(result.precleared).toBe(false);
    expect(result.payload.compliance.dncClear).toBe(false);
    expect(captured).toHaveLength(0);
  });

  it("BLOCKS an outside-calling-hours dial (DST-correct)", async () => {
    const f = await seedEligibleFixture({});
    const svc = makeService(captured, LATE_NIGHT_UTC);
    const result = await svc.issueTicket(makeInput(f));

    expect(result.precleared).toBe(false);
    expect(result.payload.compliance.withinCallingHours).toBe(false);
    expect(captured).toHaveLength(0);
    const rows = await auditRows(f.orgId, result.payload.compliance.preclearanceId);
    const failures = (rows[0].changes as Record<string, unknown>)
      .failures as Array<{ code: string }>;
    expect(failures.map((x) => x.code)).toContain("OUTSIDE_CALLING_HOURS");
  });

  it("BLOCKS a MAPD dial when the agent has no AHIP for the plan year", async () => {
    const f = await seedEligibleFixture({ withAhip: false });
    const svc = makeService(captured, MIDDAY_UTC);
    const result = await svc.issueTicket(makeInput(f));

    expect(result.precleared).toBe(false);
    expect(result.payload.compliance.agentEligible).toBe(false);
    const rows = await auditRows(f.orgId, result.payload.compliance.preclearanceId);
    const failures = (rows[0].changes as Record<string, unknown>)
      .failures as Array<{ code: string }>;
    expect(failures.map((x) => x.code)).toContain("AGENT_NO_AHIP");
  });
});
