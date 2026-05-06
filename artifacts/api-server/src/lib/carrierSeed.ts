import { eq } from "drizzle-orm";
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

export async function seedDefaultCarriers(orgId: string): Promise<number> {
  const existing = await db
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
    await db.insert(carriersTable).values(toInsert);
  }

  return toInsert.length;
}
