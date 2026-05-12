/**
 * One-shot backfill for HIPAA-2 column-level encryption.
 *
 * Walks every `contacts` row where the plaintext `medicare_id` is set but
 * the new `medicare_id_encrypted` / `medicare_id_hash` columns are still
 * NULL, computes the AES-256-GCM ciphertext + HMAC-SHA256 hash with the
 * `PHI_ENCRYPTION_KEY` / `PHI_HMAC_KEY` env vars, and UPDATEs the row.
 *
 * Designed to be safe to re-run:
 *   - skips rows that already have BOTH new columns populated
 *   - each UPDATE is its own statement, so a partial run resumes cleanly
 *
 * Run with:
 *   pnpm --filter @workspace/scripts run backfill:medicare-id
 *
 * After this script completes for every existing row, deploy with
 *   MEDICARE_ID_ENCRYPTION_ENABLED=true
 * to flip reads (search + commission reconcile) onto the hash column.
 */
import { and, isNotNull, isNull, eq, sql } from "drizzle-orm";
import {
  db,
  contactsTable,
  encryptMedicareId,
  pool,
} from "@workspace/db";

interface BackfillStats {
  scanned: number;
  updated: number;
  skipped: number;
}

export async function backfillMedicareIdEncryption(): Promise<BackfillStats> {
  const stats: BackfillStats = { scanned: 0, updated: 0, skipped: 0 };

  // Stream in modest batches so a huge contacts table doesn't load entirely
  // into memory. We use a numeric cursor on the auto-ordered `id` (text)
  // column for simplicity; for our scale (~10k contacts/org) this is fine.
  const BATCH = 500;
  let offset = 0;

  while (true) {
    const rows = await db
      .select({
        id: contactsTable.id,
        medicareId: contactsTable.medicareId,
      })
      .from(contactsTable)
      .where(
        and(
          isNotNull(contactsTable.medicareId),
          isNull(contactsTable.medicareIdEncrypted),
        ),
      )
      .limit(BATCH)
      .offset(offset);

    if (rows.length === 0) break;
    stats.scanned += rows.length;

    for (const row of rows) {
      if (!row.medicareId) {
        stats.skipped += 1;
        continue;
      }
      try {
        const { encrypted, hash } = encryptMedicareId(row.medicareId);
        await db
          .update(contactsTable)
          .set({
            medicareIdEncrypted: encrypted,
            medicareIdHash: hash,
          })
          .where(eq(contactsTable.id, row.id));
        stats.updated += 1;
      } catch (err) {
        stats.skipped += 1;
        console.error(
          `[backfill] failed for contact ${row.id}: ${(err as Error).message}`,
        );
      }
    }

    // Because the WHERE clause filters on "encrypted IS NULL", every row
    // we successfully updated is no longer in the result set on the next
    // iteration — so we DON'T advance the offset on the happy path. The
    // offset advances by the number of rows we skipped (failures), so
    // those don't trap us in an infinite loop.
    offset += stats.skipped;
    stats.skipped = 0; // reset per-batch
  }

  return stats;
}

async function main(): Promise<void> {
  const start = Date.now();
  console.log("[backfill] starting medicare_id encryption backfill...");
  const stats = await backfillMedicareIdEncryption();
  const elapsedMs = Date.now() - start;
  console.log(
    `[backfill] done in ${elapsedMs}ms — scanned=${stats.scanned} updated=${stats.updated}`,
  );

  // Sanity check: how many rows still need backfilling? Should be 0.
  const [remaining] = await db
    .select({ count: sql<number>`count(*)` })
    .from(contactsTable)
    .where(
      and(
        isNotNull(contactsTable.medicareId),
        isNull(contactsTable.medicareIdEncrypted),
      ),
    );
  console.log(`[backfill] remaining rows with plaintext-only: ${remaining?.count ?? 0}`);

  await pool.end();
}

// Allow `import { backfillMedicareIdEncryption } from "./backfill-..."`
// without auto-running when imported as a library (e.g. by tests).
const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("backfill-medicare-id-encryption.ts");

if (isDirectInvocation) {
  main().catch((err) => {
    console.error("[backfill] fatal:", err);
    process.exit(1);
  });
}
