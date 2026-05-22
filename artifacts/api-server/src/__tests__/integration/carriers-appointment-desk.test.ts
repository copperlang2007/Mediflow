/**
 * PATCH /carriers/:id (+ POST) — appointment-desk email + metadata fields.
 *
 * Added in Day-6 so INSUREitALL can configure per-carrier appointment-desk
 * addresses via the CRUD API. The email-out worker
 * (`workers/submitContractingPacket.ts`) reads these columns at job time.
 *
 * Tests cover:
 *  - PATCH accepts and persists `appointmentDeskEmail` + metadata
 *  - PATCH validates the email shape (400 on garbage)
 *  - PATCH validates `metadata.cc` element shape (must be valid emails)
 *  - PATCH accepts NULL to clear a previously-configured address
 *  - POST /carriers also accepts the new fields
 *  - Cross-org PATCH returns 404
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

import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { carriersTable } from "@workspace/db/schema";

import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser } from "../helpers/testDb";

import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}-${randomUUID().slice(0, 8)}`;
}

interface Ctx {
  org: { id: string };
  otherOrg: { id: string };
  admin: { id: string };
  otherAdmin: { id: string };
  carrierId: string;
}

async function buildCtx(): Promise<Ctx> {
  const handle = await bootTestDb();
  const org = await seedOrg(handle.db, { id: nextId("carrier-org") });
  const otherOrg = await seedOrg(handle.db, { id: nextId("carrier-other") });
  const admin = await seedUser(handle.db, {
    orgId: org.id,
    role: "super_admin",
  });
  const otherAdmin = await seedUser(handle.db, {
    orgId: otherOrg.id,
    role: "super_admin",
  });
  const carrierId = nextId("carrier");
  await handle.db.insert(carriersTable).values({
    id: carrierId,
    orgId: org.id,
    name: "Acme Health",
  });
  return { org, otherOrg, admin, otherAdmin, carrierId };
}

beforeAll(async () => {
  await bootTestDb();
  app = (await import("../../app")).default;
  request = (await import("supertest") as any).default;
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("PATCH /carriers/:id — appointment-desk fields", () => {
  it("accepts and persists appointmentDeskEmail + appointmentDeskMetadata", async () => {
    const ctx = await buildCtx();
    const res = await request(app)
      .patch(`/api/carriers/${ctx.carrierId}`)
      .set(withAuth(ctx.admin.id))
      .send({
        appointmentDeskEmail: "appointments@acme.example",
        appointmentDeskMetadata: {
          cc: ["ops@acme.example", "carrier-team@acme.example"],
          subject: "New writing-number request",
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.appointmentDeskEmail).toBe("appointments@acme.example");
    expect(res.body.appointmentDeskMetadata.cc).toEqual([
      "ops@acme.example",
      "carrier-team@acme.example",
    ]);
    expect(res.body.appointmentDeskMetadata.subject).toBe("New writing-number request");

    const handle = await bootTestDb();
    const [row] = await handle.db
      .select()
      .from(carriersTable)
      .where(eq(carriersTable.id, ctx.carrierId));
    expect(row.appointmentDeskEmail).toBe("appointments@acme.example");
  });

  it("rejects an invalid email shape with 400", async () => {
    const ctx = await buildCtx();
    const res = await request(app)
      .patch(`/api/carriers/${ctx.carrierId}`)
      .set(withAuth(ctx.admin.id))
      .send({ appointmentDeskEmail: "not-an-email" });
    expect(res.status).toBe(400);
  });

  it("rejects metadata.cc entries that are not emails", async () => {
    const ctx = await buildCtx();
    const res = await request(app)
      .patch(`/api/carriers/${ctx.carrierId}`)
      .set(withAuth(ctx.admin.id))
      .send({
        appointmentDeskMetadata: { cc: ["not-an-email"] },
      });
    expect(res.status).toBe(400);
  });

  it("accepts NULL appointmentDeskEmail to clear a previously-set address", async () => {
    const ctx = await buildCtx();
    await request(app)
      .patch(`/api/carriers/${ctx.carrierId}`)
      .set(withAuth(ctx.admin.id))
      .send({ appointmentDeskEmail: "appointments@acme.example" });
    const res = await request(app)
      .patch(`/api/carriers/${ctx.carrierId}`)
      .set(withAuth(ctx.admin.id))
      .send({ appointmentDeskEmail: null });
    expect(res.status).toBe(200);
    expect(res.body.appointmentDeskEmail).toBeNull();
  });

  it("cross-org PATCH returns 404", async () => {
    const ctx = await buildCtx();
    const res = await request(app)
      .patch(`/api/carriers/${ctx.carrierId}`)
      .set(withAuth(ctx.otherAdmin.id))
      .send({ appointmentDeskEmail: "appointments@acme.example" });
    expect(res.status).toBe(404);
  });
});

describe("POST /carriers — appointment-desk fields", () => {
  it("accepts the fields at creation time", async () => {
    const ctx = await buildCtx();
    const res = await request(app)
      .post("/api/carriers")
      .set(withAuth(ctx.admin.id))
      .send({
        name: "Brand-new carrier",
        appointmentDeskEmail: "desk@brand-new.example",
        appointmentDeskMetadata: { cc: ["ops@brand-new.example"] },
      });
    expect(res.status).toBe(201);
    expect(res.body.appointmentDeskEmail).toBe("desk@brand-new.example");
    expect(res.body.appointmentDeskMetadata.cc).toEqual(["ops@brand-new.example"]);
  });
});
