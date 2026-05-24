/**
 * Integration test: esign_signing_events immutability triggers.
 *
 * Verifies that the BEFORE UPDATE / BEFORE DELETE triggers installed by
 * migration `0022_esign_signing_events_immutability.sql` reject any
 * tampering attempt on the e-signature audit trail. The granular event
 * log is the evidence record that justifies an electronic signature;
 * application code must never be able to alter it after the fact.
 *
 * Mirrors `audit-log-immutability.test.ts` (migration 0002) — same
 * pglite + RAISE-EXCEPTION + drizzle-error-cause assertion shape.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  agentOnboardingRunsTable,
  carrierContractingRequestsTable,
  carriersTable,
  documentsTable,
  esignEnvelopesTable,
  esignSigningEventsTable,
} from "@workspace/db/schema";
import {
  setupTestDb,
  teardownTestDb,
  seedOrg,
  seedAgent,
  type TestDbHandle,
} from "../helpers/testDb";

let handle: TestDbHandle;
let orgId: string;
let envelopeId: string;
let eventId: string;

beforeAll(async () => {
  handle = await setupTestDb();

  const org = await seedOrg(handle.db, {
    id: `org-esign-imm-${randomUUID().slice(0, 8)}`,
  });
  orgId = org.id;
  const agent = await seedAgent(handle.db, { orgId });

  const carrierId = `carrier-${randomUUID().slice(0, 8)}`;
  await handle.db.insert(carriersTable).values({
    id: carrierId,
    orgId,
    name: "Acme Health",
  });

  const runId = `run-${randomUUID().slice(0, 8)}`;
  await handle.db.insert(agentOnboardingRunsTable).values({
    id: runId,
    orgId,
    agentId: agent.id,
    status: "signing",
  });

  const requestId = `req-${randomUUID().slice(0, 8)}`;
  await handle.db.insert(carrierContractingRequestsTable).values({
    id: requestId,
    orgId,
    onboardingRunId: runId,
    agentId: agent.id,
    carrierId,
    status: "paperwork_generated",
    states: ["FL"],
  });

  const docId = `doc-${randomUUID().slice(0, 8)}`;
  await handle.db.insert(documentsTable).values({
    id: docId,
    orgId,
    name: "test.pdf",
    category: "contracting",
    storageKey: `synthetic/${docId}`,
    mimeType: "application/pdf",
    fileSizeBytes: 1,
  });

  envelopeId = `env-${randomUUID().slice(0, 8)}`;
  await handle.db.insert(esignEnvelopesTable).values({
    id: envelopeId,
    orgId,
    carrierContractingRequestId: requestId,
    unsignedPdfDocumentId: docId,
    signers: [{ userId: "u1", displayName: "U", email: "u@e.com" }],
    status: "pending",
  });

  eventId = randomUUID();
  await handle.db.insert(esignSigningEventsTable).values({
    id: eventId,
    orgId,
    envelopeId,
    eventType: "envelope_created",
    actorUserId: null,
    eventData: { hello: "world" },
  });
});

afterAll(async () => {
  if (handle) await teardownTestDb(handle);
});

describe("esign_signing_events immutability triggers", () => {
  it("INSERT into esign_signing_events succeeds (baseline regression guard)", async () => {
    const id = randomUUID();
    await expect(
      handle.db.insert(esignSigningEventsTable).values({
        id,
        orgId,
        envelopeId,
        eventType: "document_viewed",
        actorUserId: null,
        eventData: {},
      }),
    ).resolves.not.toThrow();

    const rows = await handle.db
      .select()
      .from(esignSigningEventsTable)
      .where(eq(esignSigningEventsTable.id, id));
    expect(rows).toHaveLength(1);
  });

  it("rejects UPDATE on esign_signing_events rows with the append-only message", async () => {
    let caught: Error | undefined;
    try {
      await handle.db
        .update(esignSigningEventsTable)
        .set({ eventType: "consent_accepted" })
        .where(eq(esignSigningEventsTable.id, eventId));
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    const cause = (caught as Error & { cause?: { message?: string } }).cause;
    const msg = cause?.message ?? caught?.message ?? "";
    expect(msg).toMatch(/append-only|not permitted/i);
  });

  it("rejects DELETE on esign_signing_events rows with the append-only message", async () => {
    let caught: Error | undefined;
    try {
      await handle.db
        .delete(esignSigningEventsTable)
        .where(eq(esignSigningEventsTable.id, eventId));
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    const cause = (caught as Error & { cause?: { message?: string } }).cause;
    const msg = cause?.message ?? caught?.message ?? "";
    expect(msg).toMatch(/append-only|not permitted/i);
  });

  it("the original row still exists after blocked tamper attempts", async () => {
    const rows = await handle.db
      .select()
      .from(esignSigningEventsTable)
      .where(eq(esignSigningEventsTable.id, eventId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("envelope_created");
  });
});
