/**
 * GET /contacts?search= — a full name ("Maria Lopez") lives in two columns, so
 * the search also accepts a contact where every word matches some field.
 * Single words and whole-phrase matches behave as before; other agencies'
 * contacts never appear.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

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

import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser, seedContact, type TestDb } from "../helpers/testDb";
import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let testDb: TestDb;
let admin: { id: string };
const ids: Record<string, string> = {};

beforeAll(async () => {
  const handle = await bootTestDb();
  testDb = handle.db;
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as never as { default: typeof import("supertest") }).default;

  const org = await seedOrg(testDb, { id: "csearch-org" });
  const other = await seedOrg(testDb, { id: "csearch-other" });
  admin = await seedUser(testDb, { orgId: org.id, role: "agency_admin" });
  ids.maria = (await seedContact(testDb, { orgId: org.id, firstName: "Maria", lastName: "Lopez", email: "maria@lopez.test" })).id;
  ids.mariaB = (await seedContact(testDb, { orgId: org.id, firstName: "Maria", lastName: "Garcia", email: "mg@example.test" })).id;
  ids.luis = (await seedContact(testDb, { orgId: org.id, firstName: "Luis", lastName: "Lopez", email: "luis@lopez.test" })).id;
  ids.foreign = (await seedContact(testDb, { orgId: other.id, firstName: "Maria", lastName: "Lopez" })).id;
});

afterAll(async () => {
  await shutdownTestDb();
});

async function search(q: string): Promise<string[]> {
  const res = await request(app).get(`/api/contacts?search=${encodeURIComponent(q)}`).set(withAuth(admin.id));
  expect(res.status).toBe(200);
  return (res.body.data as Array<{ id: string }>).map((c) => c.id).sort();
}

describe("contact search", () => {
  it("finds a contact by full name", async () => {
    expect(await search("Maria Lopez")).toEqual([ids.maria]);
  });

  it("matches words in either order and case", async () => {
    expect(await search("lopez MARIA")).toEqual([ids.maria]);
  });

  it("every word must match, so a different surname does not match", async () => {
    expect(await search("Maria Smith")).toEqual([]);
  });

  it("a name word plus part of an email narrows to one contact", async () => {
    expect(await search("Lopez luis@")).toEqual([ids.luis]);
  });

  it("single words work as before", async () => {
    expect(await search("Lopez")).toEqual([ids.maria, ids.luis].sort());
    expect(await search("Maria")).toEqual([ids.maria, ids.mariaB].sort());
  });

  it("never returns another agency's contacts", async () => {
    expect(await search("Maria Lopez")).not.toContain(ids.foreign);
  });
});
