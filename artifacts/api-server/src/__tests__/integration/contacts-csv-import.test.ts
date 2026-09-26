/**
 * Generic CSV contact import, end to end against pglite:
 *   upload → validate → confirm → worker
 *
 * Covers the "Failed to parse CSV" fix (row-level errors instead of a
 * whole-file failure), the Medicare coverage fields written to contacts +
 * enrollments, MBI encryption (including in the queued job payload), and
 * dedupe on confirm.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

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

import { and, eq } from "drizzle-orm";
import {
  contactsTable,
  enrollmentsTable,
  carriersTable,
  importJobsTable,
} from "@workspace/db/schema";
import { decryptMedicareId } from "@workspace/db/encryption/medicareId";
import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser, seedAgent, seedContact, type TestDb } from "../helpers/testDb";
import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let worker: typeof import("../../workers/importProcessing").importCsvContactsWorker;
let tdb: TestDb;
let org: { id: string };
let admin: { id: string };
let agent: { id: string };

const HEADER = "First Name,Last Name,DOB,Address,City,County,State,Zip,Phone,Email,Medicare Number,Carrier,Plan Name,Plan Type,Effective Date,Agent Email";

const FILE = [
  HEADER,
  // 2: clean MAPD row, new carrier
  "Mary,Smith,03/07/1950,12 Oak Ln,Austin,Travis,Texas,78701,(512) 555-0101,mary@example.com,1EG4-TE5-MK73,Wellcare,Wellcare Giveback,MA-PD,01/01/2026,writer@agency.example",
  // 3: stray quote — used to fail the whole file; now imported with a warning
  'Bob,"Jones "Jr,4/2/1948,5 Elm St,Austin,Travis,TX,78702,512-555-0102,bob@example.com,,,,,,',
  // 4: same MBI as row 2, standalone PDP → same person, second enrollment
  "Mary,Smith,,,,,,,,,1EG4TE5MK73,Humana,Humana Basic Rx,Part D,1/1/2026,",
  // 5: missing last name → row-level error, skipped
  "NoLast,,,,,,,,,,,,,,,",
  // 6: unquoted comma in the address → too many values, row-level error
  "Ann,Lee,1/1/1951,9 Pine St, Apt 2,Austin,Travis,TX,78703,,,,,,,,writer@agency.example",
  // 7: shares a phone with an existing contact but a different first name (spouse) → new contact
  "Harold,Existing,,,,,,,512-555-0199,,,,,,,",
  // 8: matches existing contact by phone + first name → merged, blanks filled
  "Edna,Existing,,77 Birch Rd,Austin,,,,512-555-0199,,,,,,,",
  // 9: bad MBI + unrecognized plan type → contact imported, warnings; deduped on name + DOB
  "Carl,Diaz,5/5/1949,,,,,,,,123-45-6789,Aetna,Aetna Dental,Dental,1/1/2026,",
].join("\n");

beforeAll(async () => {
  const handle = await bootTestDb();
  tdb = handle.db;
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;
  worker = (await import("../../workers/importProcessing")).importCsvContactsWorker;

  org = await seedOrg(tdb, { id: "csv-import-org" });
  admin = await seedUser(tdb, { orgId: org.id, role: "agency_admin" });
  agent = await seedAgent(tdb, { orgId: org.id, email: "Writer@Agency.example" });
  await seedContact(tdb, { orgId: org.id, firstName: "Edna", lastName: "Existing" });
  await tdb.update(contactsTable).set({ phone: "+15125550199" }).where(eq(contactsTable.firstName, "Edna"));
});

afterAll(async () => {
  await shutdownTestDb();
});

function post(path: string, fields: Record<string, string> = {}) {
  const req = request(app).post(path).set(withAuth(admin.id)).attach("file", Buffer.from(FILE), "book.csv");
  for (const [k, v] of Object.entries(fields)) req.field(k, v);
  return req;
}

describe("generic CSV contact import", () => {
  let mapping: Record<string, string>;

  it("upload suggests the new Medicare fields and reports bad rows instead of failing", async () => {
    const res = await post("/api/imports/contacts/upload");
    expect(res.status).toBe(200);
    mapping = res.body.suggestedMapping;
    expect(mapping).toMatchObject({
      "First Name": "firstName",
      "Last Name": "lastName",
      DOB: "dob",
      Address: "address1",
      City: "city",
      County: "county",
      State: "stateCode",
      Zip: "zipCode",
      "Medicare Number": "medicareId",
      Carrier: "carrier",
      "Plan Name": "planName",
      "Plan Type": "planType",
      "Effective Date": "effectiveDate",
      "Agent Email": "assignedAgentEmail",
    });
    expect(res.body.totalRows).toBe(7);
    expect(res.body.parseIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ row: 3, severity: "warning" }),
      expect.objectContaining({ row: 6, severity: "error" }),
    ]));
  });

  it("upload rejects an Excel workbook with an actionable message", async () => {
    const res = await request(app).post("/api/imports/contacts/upload").set(withAuth(admin.id))
      .attach("file", Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), "book.xlsx");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Save As → CSV/);
  });

  it("validate returns row-level errors and warnings, and previews duplicates", async () => {
    const res = await post("/api/imports/contacts/validate", { mapping: JSON.stringify(mapping), duplicateAction: "merge" });
    expect(res.status).toBe(200);
    expect(res.body.totalRows).toBe(8);
    expect(res.body.validRows).toBe(6);
    expect(res.body.errorCount).toBe(2);
    expect(res.body.duplicateCount).toBe(2); // row 4 (MBI) + row 8 (phone + first name)
    expect(res.body.enrollmentCount).toBe(2);
    expect(res.body.newCarriers).toEqual(expect.arrayContaining(["Wellcare", "Humana"]));
    const msgs = (res.body.errors as { row: number; field: string; message: string }[]);
    expect(msgs).toEqual(expect.arrayContaining([
      expect.objectContaining({ row: 5, field: "lastName" }),
      expect.objectContaining({ row: 4, field: "duplicate", message: expect.stringMatching(/row 2.*Medicare ID/) }),
      expect.objectContaining({ row: 8, field: "duplicate" }),
      expect.objectContaining({ row: 9, field: "medicareId" }),
      expect.objectContaining({ row: 9, field: "planType" }),
    ]));
    // Harold shares Edna's phone but is a different person.
    expect(msgs.some((m) => m.row === 7 && m.field === "duplicate")).toBe(false);
    // The invalid MBI is never echoed back.
    expect(JSON.stringify(res.body)).not.toContain("123-45-6789");
  });

  it("confirm queues encrypted MBIs, and the worker writes contacts + enrollments with dedupe", async () => {
    const res = await post("/api/imports/contacts/confirm", { mapping: JSON.stringify(mapping), duplicateAction: "merge" });
    expect(res.status).toBe(200);
    const jobId = res.body.jobId as string;

    const [queued] = await tdb.select().from(importJobsTable).where(eq(importJobsTable.id, jobId));
    expect(JSON.stringify(queued!.options)).not.toMatch(/1EG4-?TE5-?MK73/);

    await worker({ jobId });

    const [job] = await tdb.select().from(importJobsTable).where(eq(importJobsTable.id, jobId));
    expect(job!.status).toBe("completed");
    expect(job!.createdCount).toBe(4); // Mary, Bob, Harold, Carl
    expect(job!.updatedCount).toBe(2); // Mary (row 4), Edna (row 8)
    expect(job!.errorCount).toBe(2); // rows 5 and 6
    expect((job!.errors as { row: number }[]).map((e) => e.row)).toEqual(expect.arrayContaining([5, 6, 9]));
    // Queued PHI is purged once the job finishes.
    expect((job!.options as { rows?: unknown }).rows).toBeUndefined();

    const contacts = await tdb.select().from(contactsTable).where(eq(contactsTable.orgId, org.id));
    const byName = (f: string) => contacts.filter((c) => c.firstName === f);

    const [mary] = byName("Mary");
    expect(byName("Mary")).toHaveLength(1);
    expect(mary).toMatchObject({
      lastName: "Smith",
      address1: "12 Oak Ln",
      city: "Austin",
      county: "Travis",
      stateCode: "TX",
      zipCode: "78701",
      phone: "+15125550101",
      assignedAgentId: agent.id,
      status: "enrolled",
      currentPlanType: "MAPD",
      planYear: 2026,
    });
    expect(mary!.dob!.toISOString().slice(0, 10)).toBe("1950-03-07");
    expect(decryptMedicareId(mary!.medicareIdEncrypted!)).toBe("1EG4TE5MK73");

    const enrollments = await tdb.select().from(enrollmentsTable).where(eq(enrollmentsTable.contactId, mary!.id));
    expect(enrollments.map((e) => e.planType).sort()).toEqual(["MAPD", "PDP"]);
    const mapd = enrollments.find((e) => e.planType === "MAPD")!;
    expect(mapd).toMatchObject({ planName: "Wellcare Giveback", effectiveDate: "2026-01-01", agentId: agent.id, status: "active", effectuated: false });
    const carriers = await tdb.select().from(carriersTable).where(and(eq(carriersTable.orgId, org.id), eq(carriersTable.name, "Wellcare")));
    expect(mapd.carrierId).toBe(carriers[0]!.id);

    expect(byName("Bob")[0]!.lastName).toBe('Jones "Jr');
    expect(byName("Harold")).toHaveLength(1);
    const [edna] = byName("Edna");
    expect(byName("Edna")).toHaveLength(1);
    expect(edna!.address1).toBe("77 Birch Rd");

    const [carl] = byName("Carl");
    expect(carl!.medicareIdEncrypted).toBeNull();
    expect(carl!.status).toBe("lead");
    expect(byName("NoLast")).toHaveLength(0);
    expect(byName("Ann")).toHaveLength(0);
  });

  it("re-importing the same file with merge creates no duplicate contacts or enrollments", async () => {
    const before = await tdb.select().from(contactsTable).where(eq(contactsTable.orgId, org.id));
    const res = await post("/api/imports/contacts/confirm", { mapping: JSON.stringify(mapping) });
    await worker({ jobId: res.body.jobId });
    const after = await tdb.select().from(contactsTable).where(eq(contactsTable.orgId, org.id));
    const names = (rows: { firstName: string }[]) => rows.map((c) => c.firstName).sort();
    expect(names(after)).toEqual(names(before));
    const enrollments = await tdb.select().from(enrollmentsTable).where(eq(enrollmentsTable.orgId, org.id));
    expect(enrollments).toHaveLength(2);
  });
});
