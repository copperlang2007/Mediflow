/**
 * HIPAA-2: column-level encryption for `contacts.medicare_id`.
 *
 * Covers:
 *   - helper round-trip (encrypt → decrypt yields the original plaintext)
 *   - helper normalization (whitespace + case-insensitive)
 *   - helper key-loading error in production when env vars are missing
 *   - dual-write: POST /contacts populates both old + new columns
 *   - flag-on exact-match search returns the contact via the hash column
 *   - flag-on commission reconcile matches via the hash column
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
import { randomUUID } from "node:crypto";
import {
  contactsTable,
  commissionStatementsTable,
  commissionLineItemsTable,
  carriersTable,
} from "@workspace/db/schema";
import {
  decryptMedicareId,
  encryptMedicareId,
  hashMedicareId,
  normalizeMedicareId,
  resetMedicareIdKeyCacheForTests,
} from "@workspace/db/encryption/medicareId";

import {
  bootTestDb,
  shutdownTestDb,
  withAuth,
} from "../helpers/testApp";
import {
  seedOrg,
  seedUser,
  seedAgent,
  seedContact,
  type TestDb,
} from "../helpers/testDb";

import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let reconcileStatement: typeof import("../../workers/reconcileCommissionStatement").reconcileStatement;
let handleDb: TestDb;

let org: { id: string };
let admin: { id: string };

beforeAll(async () => {
  const handle = await bootTestDb();
  handleDb = handle.db;
  app = (await import("../../app")).default;
  request = (await import("supertest") as any).default;
  reconcileStatement = (
    await import("../../workers/reconcileCommissionStatement")
  ).reconcileStatement;

  org = await seedOrg(handle.db, { id: "phi-enc-org" });
  admin = await seedUser(handle.db, {
    orgId: org.id,
    role: "super_admin",
  });
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("medicare_id encryption helper", () => {
  it("round-trips: encrypt → decrypt returns the original normalized plaintext", () => {
    const plain = "1AB-CD-EF23";
    const { encrypted } = encryptMedicareId(plain);
    expect(decryptMedicareId(encrypted)).toBe(plain);
  });

  it("normalizes whitespace + case before hashing", () => {
    expect(normalizeMedicareId("  abc-123  ")).toBe("ABC-123");
    const h1 = hashMedicareId("  abc-123  ");
    const h2 = hashMedicareId("ABC-123");
    expect(Buffer.compare(h1, h2)).toBe(0);
  });

  it("produces a different ciphertext on each call (non-deterministic IV) but identical hashes", () => {
    const a = encryptMedicareId("9XX-YY-ZZ77");
    const b = encryptMedicareId("9XX-YY-ZZ77");
    expect(Buffer.compare(a.encrypted, b.encrypted)).not.toBe(0);
    expect(Buffer.compare(a.hash, b.hash)).toBe(0);
  });

  it("rejects a tampered ciphertext (GCM auth tag fails)", () => {
    const { encrypted } = encryptMedicareId("1AB-CD-EF23");
    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] ^= 0x01;
    expect(() => decryptMedicareId(tampered)).toThrow();
  });

  it("throws in production when PHI_ENCRYPTION_KEY / PHI_HMAC_KEY are missing", () => {
    const prevNode = process.env.NODE_ENV;
    const prevEnc = process.env.PHI_ENCRYPTION_KEY;
    const prevHmac = process.env.PHI_HMAC_KEY;
    try {
      process.env.NODE_ENV = "production";
      delete process.env.PHI_ENCRYPTION_KEY;
      delete process.env.PHI_HMAC_KEY;
      resetMedicareIdKeyCacheForTests();
      expect(() => encryptMedicareId("foo")).toThrow(/PHI_ENCRYPTION_KEY/);
    } finally {
      process.env.NODE_ENV = prevNode;
      if (prevEnc !== undefined) process.env.PHI_ENCRYPTION_KEY = prevEnc;
      if (prevHmac !== undefined) process.env.PHI_HMAC_KEY = prevHmac;
      resetMedicareIdKeyCacheForTests();
    }
  });
});

describe("medicare_id encryption — POST /contacts dual-writes both columns", () => {
  it("populates medicare_id_encrypted + medicare_id_hash alongside the plaintext", async () => {
    const plain = "1QQ-WW-EE99";
    const res = await request(app)
      .post("/api/contacts")
      .set(withAuth(admin.id))
      .send({
        firstName: "Encrypt",
        lastName: "Tester",
        medicareId: plain,
      });
    expect(res.status).toBe(201);

    const [row] = await handleDb
      .select()
      .from(contactsTable)
      .where(eq(contactsTable.id, res.body.id))
      .limit(1);

    expect(row.medicareId).toBe(plain);
    expect(row.medicareIdEncrypted).toBeTruthy();
    expect(row.medicareIdHash).toBeTruthy();

    // Hash must match the deterministic hash of the same plaintext.
    const expectedHash = hashMedicareId(plain);
    expect(Buffer.compare(Buffer.from(row.medicareIdHash!), expectedHash)).toBe(0);

    // Encrypted bytes must decrypt back to the plaintext.
    expect(decryptMedicareId(Buffer.from(row.medicareIdEncrypted!))).toBe(plain);
  });
});

describe("medicare_id encryption — flag-on read paths", () => {
  it("GET /contacts?search=<medicareId> returns the contact via hash lookup (flag on)", async () => {
    const plain = "2RR-SS-TT88";
    await seedContact(handleDb, {
      orgId: org.id,
      firstName: "Searchable",
      lastName: "Patient",
      medicareId: plain,
    });

    const prev = process.env.MEDICARE_ID_ENCRYPTION_ENABLED;
    process.env.MEDICARE_ID_ENCRYPTION_ENABLED = "true";
    try {
      const res = await request(app)
        .get(`/api/contacts?search=${encodeURIComponent(plain)}`)
        .set(withAuth(admin.id));
      expect(res.status).toBe(200);
      const ids = res.body.data.map((c: { firstName: string }) => c.firstName);
      expect(ids).toContain("Searchable");
    } finally {
      if (prev === undefined) {
        delete process.env.MEDICARE_ID_ENCRYPTION_ENABLED;
      } else {
        process.env.MEDICARE_ID_ENCRYPTION_ENABLED = prev;
      }
    }
  });

  it("reconcile worker matches a line item to a contact via the hash column (flag on)", async () => {
    const memberId = "MBI-ENC-RECON-1";
    const agent = await seedAgent(handleDb, { orgId: org.id });
    const contact = await seedContact(handleDb, {
      orgId: org.id,
      medicareId: memberId,
    });
    // Assign the agent so resolveWritingAgent finds them.
    await handleDb
      .update(contactsTable)
      .set({ assignedAgentId: agent.id })
      .where(eq(contactsTable.id, contact.id));

    // Seed a carrier + statement + line item.
    const carrierId = `carrier-${randomUUID()}`;
    await handleDb.insert(carriersTable).values({
      id: carrierId,
      orgId: org.id,
      name: "TestCarrier",
      isActive: true,
    });

    const statementId = `stmt-${randomUUID()}`;
    await handleDb.insert(commissionStatementsTable).values({
      id: statementId,
      orgId: org.id,
      carrierId,
      statementDate: "2026-01-31",
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      source: "csv_upload",
      status: "parsed",
    });

    const lineItemId = `li-${randomUUID()}`;
    await handleDb.insert(commissionLineItemsTable).values({
      id: lineItemId,
      orgId: org.id,
      statementId,
      memberId,
      commissionAmount: "100.00",
      type: "initial",
      matchStatus: "unmatched",
    });

    const prev = process.env.MEDICARE_ID_ENCRYPTION_ENABLED;
    process.env.MEDICARE_ID_ENCRYPTION_ENABLED = "true";
    try {
      const result = await reconcileStatement(statementId, org.id);
      expect(result.matched).toBeGreaterThanOrEqual(1);
    } finally {
      if (prev === undefined) {
        delete process.env.MEDICARE_ID_ENCRYPTION_ENABLED;
      } else {
        process.env.MEDICARE_ID_ENCRYPTION_ENABLED = prev;
      }
    }

    const [updated] = await handleDb
      .select({ contactId: commissionLineItemsTable.contactId })
      .from(commissionLineItemsTable)
      .where(eq(commissionLineItemsTable.id, lineItemId))
      .limit(1);
    expect(updated.contactId).toBe(contact.id);
  });
});
