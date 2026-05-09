/**
 * Integration test: audit_log immutability triggers.
 *
 * Verifies that the BEFORE UPDATE / BEFORE DELETE triggers installed by
 * migration `0002_audit_log_immutability.sql` reject any tampering attempt.
 *
 * Status: requires a real Postgres database (DATABASE_URL set). Skipped
 * automatically otherwise. The shared integration test infra (pglite-backed
 * `__tests__/helpers/testDb.ts`) is being added on a parallel branch — once
 * that lands, this file can switch to the helper for an in-memory run.
 *
 * TODO: migrate to `__tests__/helpers/testDb.ts` once available.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "crypto";

const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

d("audit_log immutability triggers", () => {
  // Lazy imports so the test file doesn't load @workspace/db (which throws if
  // DATABASE_URL is missing) when the suite is skipped.
  let db: typeof import("@workspace/db").db;
  let auditLogTable: typeof import("@workspace/db").auditLogTable;
  let organizationsTable: typeof import("@workspace/db").organizationsTable;
  let eq: typeof import("drizzle-orm").eq;

  let orgId: string;
  let entryId: string;

  beforeAll(async () => {
    const dbMod = await import("@workspace/db");
    const drizzleMod = await import("drizzle-orm");
    db = dbMod.db;
    auditLogTable = dbMod.auditLogTable;
    organizationsTable = dbMod.organizationsTable;
    eq = drizzleMod.eq;

    // Provision an org for the FK constraint
    orgId = `test-org-${randomUUID()}`;
    await db.insert(organizationsTable).values({
      id: orgId,
      name: "Audit Immutability Test Org",
      slug: `audit-immutability-${orgId.slice(-8)}`,
    });

    entryId = randomUUID();
    await db.insert(auditLogTable).values({
      id: entryId,
      orgId,
      userId: null,
      action: "test",
      resourceType: "test",
      resourceId: null,
    });
  });

  afterAll(async () => {
    if (!orgId) return;
    // Cleanup: deletes will fail on the audit row by design, so leave it.
    // Drop org reference path only — audit row stays (which is correct).
    try {
      await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
    } catch {
      // Expected: FK from audit_log → organizations may prevent cleanup.
    }
  });

  it("rejects UPDATE on audit_log rows", async () => {
    await expect(
      db.update(auditLogTable).set({ action: "tampered" }).where(eq(auditLogTable.id, entryId)),
    ).rejects.toThrow(/immutable|not permitted/i);
  });

  it("rejects DELETE on audit_log rows", async () => {
    await expect(
      db.delete(auditLogTable).where(eq(auditLogTable.id, entryId)),
    ).rejects.toThrow(/immutable|not permitted/i);
  });
});
