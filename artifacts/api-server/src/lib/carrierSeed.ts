import { eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db, carriersTable } from "@workspace/db";

// Major Medicare carriers seeded into every new organization so the Carrier
// Certification Matrix is usable out of the box. Admins can edit/disable any
// of them after creation.
export const DEFAULT_CARRIERS = [
  "Humana",
  "UnitedHealth/AARP",
  "Aetna/CVS",
  "Cigna",
  "Anthem/BCBS",
  "Wellcare",
  "Molina",
  "Centene",
  "Devoted",
  "Oscar",
  "Clover",
];

// Advisory-lock namespace for carrier seeding (app-wide constant; must not
// collide with the migration/seed lock keys 981_234_501/981_234_502).
const CARRIER_SEED_LOCK_CLASS = 981_234_503;

export async function seedDefaultCarriers(orgId: string): Promise<number> {
  // Check-then-insert has a race: two concurrent callers for the same org
  // (double-submitted org creation, overlapping demo-seed boots) both see an
  // empty carrier list and both insert, duplicating all 11 defaults. There is
  // no unique index on (org_id, name) to backstop it — adding one to prod
  // needs a duplicate audit first — so serialize per org instead: a
  // transaction-scoped advisory lock keyed on the org makes the loser wait,
  // re-read, and no-op. The lock releases automatically at commit/rollback.
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${CARRIER_SEED_LOCK_CLASS}, hashtext(${orgId}))`,
    );

    const existing = await tx
      .select({ name: carriersTable.name })
      .from(carriersTable)
      .where(eq(carriersTable.orgId, orgId));

    const existingNames = new Set(existing.map((c) => c.name));
    const toInsert = DEFAULT_CARRIERS.filter((name) => !existingNames.has(name)).map(
      (name) => ({
        id: randomUUID(),
        orgId,
        name,
        isActive: true,
      }),
    );

    if (toInsert.length > 0) {
      await tx.insert(carriersTable).values(toInsert);
    }

    return toInsert.length;
  });
}
