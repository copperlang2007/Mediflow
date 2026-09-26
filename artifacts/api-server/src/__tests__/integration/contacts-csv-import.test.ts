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
import { parseCsvTolerant } from "../../lib/csvImport";
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

describe("interpretContactRow (review findings)", () => {
  const load = () => import("../../lib/contactImport");
  const HEADER = ["First", "Last", "Address", "City", "State", "ZIP", "AgentEmail", "EffectiveDate"];
  const mapping = { First: "firstName", Last: "lastName", Address: "address1", City: "city", State: "stateCode", ZIP: "zipCode", AgentEmail: "assignedAgentEmail", EffectiveDate: "effectiveDate" };

  it("skips a row whose columns are shifted even when its value count matches the header", async () => {
    const { interpretContactRow } = await load();
    const parsed = parseCsvTolerant(Buffer.from(`${HEADER.join(",")}\nJohn,Roe,9 Pine St, Apt 2,Austin,TX,78701,\n`));
    expect(parsed.issues).toEqual([]); // indistinguishable by counting alone
    const r = interpretContactRow(parsed.rows[0]!, mapping, 2);
    expect(r.contact).toBeNull();
    expect(r.issues).toContainEqual(expect.objectContaining({ field: "row", severity: "error", message: expect.stringMatching(/shifted/) }));
  });

  it("never echoes cell values (PHI) into row messages", async () => {
    const { interpretContactRow } = await load();
    const r = interpretContactRow(
      { f: "Jane", l: "Doe", e: "beneficiary.jane.doe@example", d: "1955-13-99", s: "Zzzland", a: "Alice Smith", z: "7870" },
      { f: "firstName", l: "lastName", e: "email", d: "dob", s: "stateCode", a: "assignedAgentEmail", z: "zipCode" },
      2,
    );
    const text = JSON.stringify(r.issues);
    for (const v of ["beneficiary.jane.doe@example", "1955-13-99", "Zzzland", "Alice Smith"]) expect(text).not.toContain(v);
  });

  it("restores ZIP leading zeros Excel dropped", async () => {
    const { interpretContactRow } = await load();
    const r = interpretContactRow({ f: "A", l: "B", z: "2134" }, { f: "firstName", l: "lastName", z: "zipCode" }, 2);
    expect(r.contact!.zipCode).toBe("02134");
  });

  it("does not merge people who only share a phone and first name", async () => {
    const { ContactMatcher } = await load();
    const m = new ContactMatcher();
    m.add({ id: "sr", firstName: "John", lastName: "Smith", dob: "1940-01-01", email: null, phone: "+15551234567" });
    m.add({ id: "fac", firstName: "Mary", lastName: "Jones", dob: null, email: null, phone: "+15550000000" });
    const base = { email: null, address1: null, city: null, county: null, stateCode: null, zipCode: null, leadSource: null, tags: [], optOut: false, mbi: null, assignedAgentEmail: null };
    // Jr: same name + phone, different DOB → different person.
    expect(m.find({ ...base, firstName: "John", lastName: "Smith", dob: "1965-01-01", phone: "+15551234567" })).toBeNull();
    // Care facility phone: same first name, different last name → different person.
    expect(m.find({ ...base, firstName: "Mary", lastName: "Brown", dob: null, phone: "+15550000000" })).toBeNull();
    // Same person.
    expect(m.find({ ...base, firstName: "john", lastName: "smith", dob: "1940-01-01", phone: "+15551234567" })?.match.id).toBe("sr");
  });
});

describe("worker robustness (review findings)", () => {
  it("a retried job produces the same error report, not a growing one", async () => {
    const { processCsvContactImport } = await import("../../lib/contactImport");
    const upload = await post("/api/imports/contacts/upload");
    const mapping = upload.body.suggestedMapping;
    const res = await post("/api/imports/contacts/confirm", { mapping: JSON.stringify(mapping), duplicateAction: "skip" });
    const jobId = res.body.jobId as string;
    const [queued] = await tdb.select().from(importJobsTable).where(eq(importJobsTable.id, jobId));
    const opts = queued!.options as { rows: Record<string, string>[]; mapping: Record<string, string> };

    await processCsvContactImport(jobId, org.id, opts.rows, opts.mapping, "skip");
    const [first] = await tdb.select().from(importJobsTable).where(eq(importJobsTable.id, jobId));
    // Simulate a crash-and-retry: the job is re-run from its original queued payload.
    await tdb.update(importJobsTable).set({ status: "processing", options: queued!.options }).where(eq(importJobsTable.id, jobId));
    await processCsvContactImport(jobId, org.id, opts.rows, opts.mapping, "skip");
    const [second] = await tdb.select().from(importJobsTable).where(eq(importJobsTable.id, jobId));

    expect(second!.errors).toEqual(first!.errors);
    expect(second!.errorCount).toBe(first!.errorCount);
  });

  it("warns instead of silently dropping an imported Medicare ID that conflicts with the one on file", async () => {
    await seedContact(tdb, { orgId: org.id, firstName: "Iris", lastName: "Conflict", email: "iris@example.com", medicareId: "1EG4TE5MK73" });
    const file = "First Name,Last Name,Email,Medicare Number\nIris,Conflict,iris@example.com,2AC3CD4EF56\n";
    const up = await request(app).post("/api/imports/contacts/upload").set(withAuth(admin.id)).attach("file", Buffer.from(file), "c.csv");
    const res = await request(app).post("/api/imports/contacts/confirm").set(withAuth(admin.id))
      .attach("file", Buffer.from(file), "c.csv").field("mapping", JSON.stringify(up.body.suggestedMapping));
    await worker({ jobId: res.body.jobId });
    const [job] = await tdb.select().from(importJobsTable).where(eq(importJobsTable.id, res.body.jobId));
    expect(job!.updatedCount).toBe(1);
    expect(job!.errors).toContainEqual(expect.objectContaining({ field: "medicareId", message: expect.stringMatching(/differs/) }));
    const [iris] = await tdb.select().from(contactsTable).where(eq(contactsTable.email, "iris@example.com"));
    expect(decryptMedicareId(iris!.medicareIdEncrypted!)).toBe("1EG4TE5MK73");
  });
});

describe("carrier-less enrollments", () => {
  it("re-importing a plan row with no carrier updates, not duplicates, the enrollment (NULLS NOT DISTINCT)", async () => {
    const file = "First Name,Last Name,DOB,Plan Type,Effective Date\nNora,Nocarrier,1/2/1948,PDP,1/1/2026\n";
    for (let i = 0; i < 2; i++) {
      const up = await request(app).post("/api/imports/contacts/upload").set(withAuth(admin.id)).attach("file", Buffer.from(file), "n.csv");
      const res = await request(app).post("/api/imports/contacts/confirm").set(withAuth(admin.id))
        .attach("file", Buffer.from(file), "n.csv").field("mapping", JSON.stringify(up.body.suggestedMapping));
      await worker({ jobId: res.body.jobId });
    }
    const [nora] = await tdb.select().from(contactsTable).where(eq(contactsTable.lastName, "Nocarrier"));
    const rows = await tdb.select().from(enrollmentsTable).where(eq(enrollmentsTable.contactId, nora!.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.carrierId).toBeNull();
  });
});

describe("review round 3", () => {
  it("skips a shifted row whose other values all validate ('Suite 100' in City)", async () => {
    const { interpretContactRow } = await import("../../lib/contactImport");
    const mapping = { First: "firstName", Last: "lastName", Address: "address1", City: "city", State: "stateCode", Phone: "phone" };
    const r = interpretContactRow({ First: "John", Last: "Roe", Address: "12 Main St", City: "Suite 100", State: "TX", Phone: "5125550001" }, mapping, 2);
    expect(r.contact).toBeNull();
    expect(r.issues).toContainEqual(expect.objectContaining({ field: "row", severity: "error" }));
  });

  it("matches an existing carrier whose name contains an 's' (DB-side whitespace normalization)", async () => {
    await tdb.insert(carriersTable).values({ id: "carrier-bcbs", orgId: org.id, name: "Blue Cross  Blue Shield" });
    const file = "First Name,Last Name,DOB,Carrier,Plan Type,Effective Date\nSal,Shield,3/3/1947,blue cross blue shield,MA,1/1/2026\n";
    const up = await request(app).post("/api/imports/contacts/upload").set(withAuth(admin.id)).attach("file", Buffer.from(file), "b.csv");
    const res = await request(app).post("/api/imports/contacts/confirm").set(withAuth(admin.id))
      .attach("file", Buffer.from(file), "b.csv").field("mapping", JSON.stringify(up.body.suggestedMapping));
    await worker({ jobId: res.body.jobId });
    const bcbs = await tdb.select().from(carriersTable).where(eq(carriersTable.orgId, org.id));
    expect(bcbs.filter((c) => c.name.toLowerCase().replace(/\s+/g, " ") === "blue cross blue shield")).toHaveLength(1);
    const [sal] = await tdb.select().from(contactsTable).where(eq(contactsTable.lastName, "Shield"));
    const [enr] = await tdb.select().from(enrollmentsTable).where(eq(enrollmentsTable.contactId, sal!.id));
    expect(enr!.carrierId).toBe("carrier-bcbs");
  });
});
