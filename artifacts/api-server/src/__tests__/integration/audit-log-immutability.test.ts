/**
 * Integration test: audit_log immutability triggers.
 *
 * Verifies that the BEFORE UPDATE / BEFORE DELETE triggers installed by
 * migration `0002_audit_log_immutability.sql` reject any tampering attempt.
 *
 * Runs against the in-memory pglite harness (`__tests__/helpers/testDb.ts`).
 * Recent pglite versions support `RAISE EXCEPTION` from a `LANGUAGE plpgsql`
 * trigger function, which is what migration 0002 uses.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { auditLogTable, organizationsTable } from "@workspace/db/schema";
import {
  setupTestDb,
  teardownTestDb,
  type TestDbHandle,
} from "../helpers/testDb";

let handle: TestDbHandle;
let orgId: string;
let entryId: string;

beforeAll(async () => {
  handle = await setupTestDb();

  orgId = `org-audit-imm-${randomUUID().slice(0, 8)}`;
  await handle.db.insert(organizationsTable).values({
    id: orgId,
    name: "Audit Immutability Test Org",
    slug: `audit-imm-${orgId.slice(-8)}`,
  });

  entryId = randomUUID();
  await handle.db.insert(auditLogTable).values({
    id: entryId,
    orgId,
    userId: null,
    action: "test",
    resourceType: "test",
    resourceId: null,
  });
});

afterAll(async () => {
  if (handle) await teardownTestDb(handle);
});

describe("audit_log immutability triggers", () => {
  it("INSERT into audit_log succeeds (baseline)", async () => {
    const id = randomUUID();
    await expect(
      handle.db.insert(auditLogTable).values({
        id,
        orgId,
        userId: null,
        action: "baseline-insert",
        resourceType: "test",
        resourceId: null,
      }),
    ).resolves.not.toThrow();

    const rows = await handle.db
      .select()
      .from(auditLogTable)
      .where(eq(auditLogTable.id, id));
    expect(rows).toHaveLength(1);
  });

  it("rejects UPDATE on audit_log rows with the immutability message", async () => {
    let caught: Error | undefined;
    try {
      await handle.db
        .update(auditLogTable)
        .set({ action: "tampered" })
        .where(eq(auditLogTable.id, entryId));
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    // Drizzle wraps the underlying pg error; the original message is on `.cause`.
    const cause = (caught as Error & { cause?: { message?: string } }).cause;
    const msg = cause?.message ?? caught?.message ?? "";
    expect(msg).toMatch(/immutable|not permitted/i);
  });

  it("rejects DELETE on audit_log rows with the immutability message", async () => {
    let caught: Error | undefined;
    try {
      await handle.db
        .delete(auditLogTable)
        .where(eq(auditLogTable.id, entryId));
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    const cause = (caught as Error & { cause?: { message?: string } }).cause;
    const msg = cause?.message ?? caught?.message ?? "";
    expect(msg).toMatch(/immutable|not permitted/i);
  });

  it("rejects TRUNCATE on audit_log with the immutability message", async () => {
    // The UPDATE/DELETE triggers from migration 0002 are row-level, and
    // row-level triggers never fire on TRUNCATE — Postgres drops the rows
    // without visiting them. Before migration 0042 this statement silently
    // erased the whole audit trail while the two tests above still passed.
    let caught: Error | undefined;
    try {
      await handle.db.execute(sql`truncate table audit_log`);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    const cause = (caught as Error & { cause?: { message?: string } }).cause;
    const msg = cause?.message ?? caught?.message ?? "";
    expect(msg).toMatch(/immutable|not permitted/i);
  });

  it("the original row still exists after blocked tamper attempts", async () => {
    const rows = await handle.db
      .select()
      .from(auditLogTable)
      .where(eq(auditLogTable.id, entryId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("test");
  });
});
