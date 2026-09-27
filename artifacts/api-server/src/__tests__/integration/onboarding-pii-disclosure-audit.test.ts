/**
 * QA fix #1 — contracting-profile SSN / EIN / DOB disclosure.
 *
 * Design (unchanged): the API returns plaintext only to PHI-privileged roles
 * (super_admin, agency_admin, compliance_manager) because contracting needs it
 * for carrier submissions; everyone else gets fixed masked sentinels.
 *
 * What these tests pin:
 *   - privileged GET /onboarding/:agentId still returns plaintext, AND now
 *     writes an audit_log row (`contracting_pii_disclosed`) naming the fields
 *     disclosed — with NO SSN/EIN/DOB value anywhere in the row;
 *   - a non-privileged reader (agent_support) gets masked values and no
 *     disclosure row;
 *   - another org's user gets 404 and no disclosure row;
 *   - a privileged reader of a profile with nothing sensitive on file writes
 *     no disclosure row.
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

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  agentOnboardingRunsTable,
  agentContractingProfilesTable,
  auditLogTable,
} from "@workspace/db/schema";
import { encryptSsn, encryptEin } from "@workspace/db/encryption/pii";

import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser, seedAgent } from "../helpers/testDb";
import type { TestDb } from "../helpers/testDb";
import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let testDb: TestDb;

let org: { id: string };
let otherOrg: { id: string };
let superAdmin: { id: string };
let support: { id: string };
let outsider: { id: string };
let agent: { id: string };
let bareAgent: { id: string };

const SSN = "999-77-8899";
const EIN = "12-3456789";
const DOB = "1985-11-04";

async function startRun(agentId: string, orgId: string): Promise<void> {
  await testDb.insert(agentOnboardingRunsTable).values({
    id: `run-${randomUUID()}`,
    orgId,
    agentId,
    status: "profile_in_progress",
  });
}

async function disclosureRows(agentId: string) {
  return testDb
    .select()
    .from(auditLogTable)
    .where(
      and(
        eq(auditLogTable.action, "contracting_pii_disclosed"),
        eq(auditLogTable.resourceId, agentId),
      ),
    );
}

beforeAll(async () => {
  const handle = await bootTestDb();
  testDb = handle.db;
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;

  org = await seedOrg(testDb, { id: "pii-org" });
  otherOrg = await seedOrg(testDb, { id: "pii-other-org" });
  superAdmin = await seedUser(testDb, { orgId: org.id, role: "super_admin" });
  support = await seedUser(testDb, { orgId: org.id, role: "agent_support" });
  outsider = await seedUser(testDb, { orgId: otherOrg.id, role: "agency_admin" });

  agent = await seedAgent(testDb, { orgId: org.id, lastName: "Park" });
  await startRun(agent.id, org.id);
  const ssn = encryptSsn(SSN);
  await testDb.insert(agentContractingProfilesTable).values({
    agentId: agent.id,
    orgId: org.id,
    ssnEncrypted: ssn.encrypted,
    ssnHash: ssn.hash,
    businessEinEncrypted: encryptEin(EIN).encrypted,
    dob: DOB,
    phone: "+15555550144",
  });

  bareAgent = await seedAgent(testDb, { orgId: org.id, lastName: "Blank" });
  await startRun(bareAgent.id, org.id);
  await testDb.insert(agentContractingProfilesTable).values({
    agentId: bareAgent.id,
    orgId: org.id,
    phone: "+15555550145",
  });
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("GET /onboarding/:agentId — contracting PII", () => {
  it("returns plaintext to a privileged role and audits the disclosure without the values", async () => {
    const before = (await disclosureRows(agent.id)).length;
    const res = await request(app)
      .get(`/api/onboarding/${agent.id}`)
      .set(withAuth(superAdmin.id));
    expect(res.status).toBe(200);
    expect(res.body.profile.ssn).toBe(SSN);
    expect(res.body.profile.ein).toBe(EIN);
    expect(res.body.profile.dob).toBe(DOB);

    const rows = await disclosureRows(agent.id);
    expect(rows.length).toBe(before + 1);
    const row = rows.at(-1)!;
    expect(row.orgId).toBe(org.id);
    expect(row.userId).toBe(superAdmin.id);
    expect(row.resourceType).toBe("agent_contracting_profile");
    expect((row.changes as { fields: string[] }).fields.sort()).toEqual(["dob", "ein", "ssn"]);

    // No PHI in the audit row, in any form.
    const serialized = JSON.stringify(row);
    for (const needle of ["8899", "999-77", "999778899", "3456789", "1985-11-04"]) {
      expect(serialized).not.toContain(needle);
    }
  });

  it("masks for a non-privileged reader and writes no disclosure row", async () => {
    const before = (await disclosureRows(agent.id)).length;
    const res = await request(app)
      .get(`/api/onboarding/${agent.id}`)
      .set(withAuth(support.id));
    expect(res.status).toBe(200);
    expect(res.body.profile.ssn).toBe("***-**-****");
    expect(res.body.profile.ein).toBe("**-*******");
    expect(res.body.profile.dob).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain("8899");
    expect((await disclosureRows(agent.id)).length).toBe(before);
  });

  it("404s for another org and writes no disclosure row", async () => {
    const before = (await disclosureRows(agent.id)).length;
    const res = await request(app)
      .get(`/api/onboarding/${agent.id}`)
      .set(withAuth(outsider.id));
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain("8899");
    expect((await disclosureRows(agent.id)).length).toBe(before);
  });

  it("writes no disclosure row when nothing sensitive is on file", async () => {
    const res = await request(app)
      .get(`/api/onboarding/${bareAgent.id}`)
      .set(withAuth(superAdmin.id));
    expect(res.status).toBe(200);
    expect(res.body.profile.ssn).toBeNull();
    expect((await disclosureRows(bareAgent.id)).length).toBe(0);
  });

  it("requires auth", async () => {
    const res = await request(app).get(`/api/onboarding/${agent.id}`);
    expect([401, 403]).toContain(res.status);
  });
});
