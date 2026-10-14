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
import * as schema from "@workspace/db/schema";
import { randomUUID } from "node:crypto";

import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let db: TestDb;

let org: { id: string };
let otherOrg: { id: string };
let admin: { id: string };
let agent: { id: string };
let contact: { id: string };
let otherContact: { id: string };

// Two distinct parse timestamps so we can assert newest-first ordering.
const OLDER_PARSED_AT = new Date("2026-01-10T12:00:00Z");
const NEWER_PARSED_AT = new Date("2026-02-20T09:30:00Z");

function parsedPayload(opts: {
  summary: string;
  category:
    | "POSITIVE"
    | "NEUTRAL"
    | "NEGATIVE"
    | "COMPLIANCE"
    | "FOLLOW_UP"
    | "UNKNOWN";
}) {
  return {
    summary: opts.summary,
    suggestedDisposition: {
      code: "DISP_1",
      category: opts.category,
      confidence: 0.82,
    },
    riskFlags: [{ kind: "tcpa_consent", severity: "high", detail: "no consent on file" }],
    actionItems: ["Send SOA form", "Schedule follow-up call"],
  };
}

async function seedTicket(opts: {
  orgId: string;
  contactRef: string | null;
  status?: string;
  dialerCallId?: string | null;
  transcriptParsed?: unknown;
  transcriptParsedAt?: Date | null;
  transcriptReadyAt?: Date | null;
}): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.dialTicketsTable).values({
    id,
    orgId: opts.orgId,
    contactRef: opts.contactRef,
    status: opts.status ?? "COMPLETED",
    dialerCallId: opts.dialerCallId ?? `call-${id.slice(0, 8)}`,
    transcriptParsed: (opts.transcriptParsed ?? null) as never,
    transcriptParsedAt: opts.transcriptParsedAt ?? null,
    transcriptReadyAt: opts.transcriptReadyAt ?? null,
  });
  return id;
}

let newerTicketId: string;
let olderTicketId: string;

beforeAll(async () => {
  const handle = await bootTestDb();
  db = handle.db;
  app = (await import("../../app")).default;
  request = (await import("supertest") as any).default;

  org = await seedOrg(db, { id: "cs-org" });
  otherOrg = await seedOrg(db, { id: "cs-other-org" });
  // agency_admin has contact:read; agent does NOT (permission gate target).
  admin = await seedUser(db, { orgId: org.id, role: "agency_admin" });
  agent = await seedUser(db, { orgId: org.id, role: "agent" });

  contact = await seedContact(db, { orgId: org.id });
  otherContact = await seedContact(db, { orgId: org.id });

  // 1) Older parsed ticket for the target contact.
  olderTicketId = await seedTicket({
    orgId: org.id,
    contactRef: contact.id,
    transcriptParsed: parsedPayload({ summary: "Older call summary", category: "FOLLOW_UP" }),
    transcriptParsedAt: OLDER_PARSED_AT,
    transcriptReadyAt: OLDER_PARSED_AT,
  });
  // 2) Newer parsed ticket for the target contact.
  newerTicketId = await seedTicket({
    orgId: org.id,
    contactRef: contact.id,
    transcriptParsed: parsedPayload({ summary: "Newer call summary", category: "POSITIVE" }),
    transcriptParsedAt: NEWER_PARSED_AT,
    transcriptReadyAt: NEWER_PARSED_AT,
  });
  // 3) Ticket for the target contact with NO parsed transcript — excluded.
  await seedTicket({
    orgId: org.id,
    contactRef: contact.id,
    transcriptParsed: null,
    transcriptParsedAt: null,
  });
  // 4) Parsed ticket for a DIFFERENT contact (same org) — excluded.
  await seedTicket({
    orgId: org.id,
    contactRef: otherContact.id,
    transcriptParsed: parsedPayload({ summary: "Other contact summary", category: "NEUTRAL" }),
    transcriptParsedAt: NEWER_PARSED_AT,
  });
  // 5) Parsed ticket for a DIFFERENT org, same contactRef value — excluded.
  await seedTicket({
    orgId: otherOrg.id,
    contactRef: contact.id,
    transcriptParsed: parsedPayload({ summary: "Cross-org summary", category: "NEGATIVE" }),
    transcriptParsedAt: NEWER_PARSED_AT,
  });
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("GET /contacts/:id/call-summaries", () => {
  it("returns only the parsed summaries for the right contact, newest-first", async () => {
    const res = await request(app)
      .get(`/api/contacts/${contact.id}/call-summaries`)
      .set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.data).toHaveLength(2);

    // Newest-first ordering by parsedAt.
    expect(res.body.data[0].ticketId).toBe(newerTicketId);
    expect(res.body.data[1].ticketId).toBe(olderTicketId);
    expect(res.body.data[0].summary).toBe("Newer call summary");
    expect(res.body.data[1].summary).toBe("Older call summary");
  });

  it("exposes summary / suggestedDisposition / riskFlags / actionItems", async () => {
    const res = await request(app)
      .get(`/api/contacts/${contact.id}/call-summaries`)
      .set(withAuth(admin.id));
    expect(res.status).toBe(200);
    const top = res.body.data[0];
    expect(top.summary).toBe("Newer call summary");
    expect(top.suggestedDisposition).toEqual({
      code: "DISP_1",
      category: "POSITIVE",
      confidence: 0.82,
    });
    expect(top.riskFlags).toEqual([
      { kind: "tcpa_consent", severity: "high", detail: "no consent on file" },
    ]);
    expect(top.actionItems).toEqual(["Send SOA form", "Schedule follow-up call"]);
    expect(top.status).toBe("COMPLETED");
    expect(top.parsedAt).toBeTruthy();
    expect(top.dialerCallId).toBeTruthy();
  });

  it("excludes unparsed, other-contact, and other-org tickets", async () => {
    const res = await request(app)
      .get(`/api/contacts/${contact.id}/call-summaries`)
      .set(withAuth(admin.id));
    expect(res.status).toBe(200);
    const summaries: string[] = res.body.data.map((d: { summary: string }) => d.summary);
    expect(summaries).not.toContain("Other contact summary");
    expect(summaries).not.toContain("Cross-org summary");
    // Only the two parsed target-contact rows survive.
    expect(summaries.sort()).toEqual(["Newer call summary", "Older call summary"]);
  });

  it("enforces the contact:read permission gate (agent role -> 403)", async () => {
    const res = await request(app)
      .get(`/api/contacts/${contact.id}/call-summaries`)
      .set(withAuth(agent.id));
    expect(res.status).toBe(403);
  });

  it("returns 404 for a contact in another org", async () => {
    const ghost = await seedContact(db, { orgId: otherOrg.id });
    const res = await request(app)
      .get(`/api/contacts/${ghost.id}/call-summaries`)
      .set(withAuth(admin.id));
    expect(res.status).toBe(404);
  });
});
