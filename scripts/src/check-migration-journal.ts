/**
 * Verify the drizzle migration journal is in sync with the *.sql files
 * on disk.
 *
 * Catches the kind of drift that's easy to introduce by hand: adding a
 * new migration SQL file but forgetting to register it in
 * `lib/db/migrations/meta/_journal.json`. Drizzle's migrator reads ONLY
 * the journal when applying — so an unregistered SQL file silently fails
 * to run in production, and a stale journal entry whose SQL was deleted
 * makes the migrator throw on boot.
 *
 * Validations:
 *   1. Every *.sql file in migrations/ has a journal entry with a
 *      matching `tag` (filename minus the .sql extension).
 *   2. Every journal entry has a matching *.sql file.
 *   3. Journal entries are sequentially numbered (`idx` is 0, 1, 2, ...,
 *      no gaps, no duplicates).
 *
 * Note: the 4-digit filename PREFIX (e.g. `0024_...`) does NOT have to
 * match the journal `idx`. This repo's history contains an intentional
 * `0002a_schema_drift_backfill` inserted between 0002 and 0003 that
 * decoupled prefix from idx going forward. The invariants that matter
 * are file↔entry pairing and gap-free idx sequence.
 *
 * Run from the repo root:
 *   pnpm exec tsx scripts/src/check-migration-journal.ts
 *
 * Exits 0 on success, 1 with a human-readable error list on failure.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const migrationsDir = path.join(repoRoot, "lib", "db", "migrations");
const journalPath = path.join(migrationsDir, "meta", "_journal.json");

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

async function listSqlFiles(): Promise<string[]> {
  const all = await readdir(migrationsDir);
  return (
    all
      .filter((name) => name.endsWith(".sql"))
      // Exclude hand-written `*_down.sql` files. They're paired with their
      // up-direction counterpart and don't carry their own journal entry —
      // drizzle's migrator never reads them (only the forward chain). Today
      // there's just one: 0000_broken_red_hulk_down.sql.
      .filter((name) => !name.endsWith("_down.sql"))
      .sort()
  );
}

async function readJournal(): Promise<Journal> {
  const raw = await readFile(journalPath, "utf8");
  return JSON.parse(raw) as Journal;
}

function checkJournalSequence(journal: Journal): string[] {
  const errors: string[] = [];
  const sorted = [...journal.entries].sort((a, b) => a.idx - b.idx);
  for (let expected = 0; expected < sorted.length; expected++) {
    const actual = sorted[expected]!.idx;
    if (actual !== expected) {
      errors.push(
        `Journal idx gap or duplicate: expected idx=${expected} at position ${expected}, got idx=${actual} (tag=${sorted[expected]!.tag}).`,
      );
      // Continue checking so we surface all gaps in one pass, not just the first.
    }
  }
  return errors;
}

function diffSqlVsJournal(
  sqlFiles: string[],
  journal: Journal,
): string[] {
  const errors: string[] = [];
  const tags = new Set(journal.entries.map((e) => e.tag));
  const filesAsTags = new Set(sqlFiles.map((f) => f.replace(/\.sql$/, "")));

  for (const file of sqlFiles) {
    const tag = file.replace(/\.sql$/, "");
    if (!tags.has(tag)) {
      errors.push(
        `Migration file has no journal entry: ${file}. ` +
          `Run \`pnpm --filter @workspace/db generate\` or add an entry by hand to \`meta/_journal.json\`.`,
      );
    }
  }
  for (const entry of journal.entries) {
    if (!filesAsTags.has(entry.tag)) {
      errors.push(
        `Journal entry has no matching SQL file: tag="${entry.tag}". ` +
          `The SQL file may have been deleted — remove the journal entry or restore the file.`,
      );
    }
  }
  return errors;
}

async function main(): Promise<void> {
  const [sqlFiles, journal] = await Promise.all([
    listSqlFiles(),
    readJournal(),
  ]);

  const errors = [
    ...diffSqlVsJournal(sqlFiles, journal),
    ...checkJournalSequence(journal),
  ];

  if (errors.length === 0) {
    console.log(
      `Migration journal OK — ${journal.entries.length} entries match ${sqlFiles.length} SQL files.`,
    );
    return;
  }

  console.error("Migration journal drift detected:\n");
  for (const e of errors) console.error(`  - ${e}`);
  console.error(
    `\n${errors.length} issue${errors.length === 1 ? "" : "s"} found. ` +
      `Fix the journal/SQL drift before merging.`,
  );
  process.exit(1);
}

main().catch((err) => {
  console.error("check-migration-journal: unexpected failure");
  console.error(err);
  process.exit(2);
});
