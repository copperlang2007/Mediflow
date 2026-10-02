/**
 * Import the agencyBRIDGE Medicare knowledge base into one Mediflow agency.
 *
 * Source: agencyBRIDGE `src/lib/medicareKnowledge.ts` (reference notes on
 * commissions, Medicaid, LIS, plan types, carriers, election periods and
 * needs analysis). The 16 entries that describe agencyBRIDGE's own agent
 * skills and product features are NOT imported — they would mislead
 * Mediflow's assistant. The remaining 61 live in `data/agencybridge-kb.json`.
 *
 * Meant as a ONE-TIME starter import. Article ids are derived from the org
 * and entry key and existing rows are never overwritten, so edits made in the
 * app survive. But a hard-deleted article looks "never imported", so a re-run
 * would bring it back. To stop that happening by accident, the script refuses
 * to run on an agency that already has imported articles unless you pass
 * `--allow-rerun` (which restores anything deleted).
 *
 * EVERY article is imported INACTIVE. The source is a snapshot written in
 * 2025: it holds dated figures (commission caps, LIS limits) and rules that
 * have since changed (SOA wait period, moving-SEP window, carrier names and
 * channels). Active articles are fed straight to the AI assistant, so an
 * agency owner must review each one against current CMS/carrier guidance and
 * switch it on in the app.
 *
 * Run:
 *   pnpm --filter @workspace/scripts run import:agencybridge-kb -- <orgId> [--dry-run] [--allow-rerun]
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, like } from "drizzle-orm";
import { db, kbArticlesTable, organizationsTable } from "@workspace/db";

interface Entry {
  key: string;
  category: string;
  title: string;
  content: string;
  keywords: string[];
  needsReview: boolean;
}

const entries: Entry[] = JSON.parse(
  readFileSync(new URL("./data/agencybridge-kb.json", import.meta.url), "utf8"),
);

/** Same rules as the app: lower-case, trim, de-duplicate, max 50 keywords. */
function normalizeKeywords(keywords: string[]): string[] {
  const seen = new Set<string>();
  for (const raw of keywords) {
    const k = raw.trim().toLowerCase().slice(0, 60);
    if (k) seen.add(k);
  }
  return [...seen].slice(0, 50);
}

function articleId(orgId: string, key: string): string {
  return `kb-ab-${createHash("sha256").update(`${orgId}:${key}`).digest("hex").slice(0, 24)}`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const dryRun = args.includes("--dry-run");
  const orgId = args.find((a) => !a.startsWith("--"));
  if (!orgId) {
    console.error("Usage: import:agencybridge-kb -- <orgId> [--dry-run]");
    process.exit(1);
  }

  const [org] = await db
    .select({ id: organizationsTable.id })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId))
    .limit(1);
  if (!org) {
    console.error(`No organization with id "${orgId}".`);
    process.exit(1);
  }

  const already = await db
    .select({ id: kbArticlesTable.id })
    .from(kbArticlesTable)
    .where(and(eq(kbArticlesTable.orgId, orgId), like(kbArticlesTable.id, "kb-ab-%")))
    .limit(1);
  if (already.length > 0 && !args.includes("--allow-rerun")) {
    console.error(
      "This agency already has imported articles. Re-running would restore any you deleted.\n" +
        "Pass --allow-rerun if that is what you want.",
    );
    process.exit(1);
  }

  let inserted = 0;
  for (const e of entries) {
    if (dryRun) {
      const [existing] = await db
        .select({ id: kbArticlesTable.id })
        .from(kbArticlesTable)
        .where(eq(kbArticlesTable.id, articleId(orgId, e.key)))
        .limit(1);
      if (!existing) inserted++;
      continue;
    }
    const rows = await db
      .insert(kbArticlesTable)
      .values({
        id: articleId(orgId, e.key),
        orgId,
        category: e.category,
        title: e.title,
        content: e.content,
        keywords: normalizeKeywords(e.keywords),
        isActive: false,
        createdBy: null,
      })
      .onConflictDoNothing()
      .returning({ id: kbArticlesTable.id });
    inserted += rows.length;
  }

  console.log(
    `${dryRun ? "[dry run] would import" : "Imported"} ${inserted} of ${entries.length} articles` +
      ` (${entries.length - inserted} already present). All are inactive until reviewed.`,
  );
  process.exit(0);
}

void main();
