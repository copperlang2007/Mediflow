/**
 * The ingest core: take one file from a source and turn it into a statement
 * (or into a review item saying exactly why not).
 *
 * Order of operations is chosen so nothing is ever half-applied:
 *   1. CLAIM    insert the ledger row; the unique key makes a re-listed file a no-op
 *   2. CHECK    carrier, parser, lines, period, duplicate period: any miss -> needs_review
 *   3. STORE    file bytes to the private bucket
 *   4. CREATE   statement + line items in ONE transaction
 *   5. RECONCILE only in 'auto' mode; 'hold' stops after CREATE until someone approves
 *
 * Ledger reasons never contain file content: statements carry PHI.
 */
import { randomUUID } from "crypto";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import {
  db,
  carriersTable,
  commissionStatementsTable,
  statementIngestFilesTable,
  type StatementIngestFile,
  type StatementIngestSource,
} from "@workspace/db";
import { parseStatement, UnknownCarrierError, type NormalizedLineItem } from "../commissionParsers";
import { insertLineItems } from "../commissions/insertLineItems";
import { reconcileStatement } from "../../workers/reconcileCommissionStatement";
import { ObjectStorageService } from "../objectStorage";
import { logger } from "../logger";
import { inferCarrier, inferPeriod, inferStatementDate, isSupportedStatementFile } from "./infer";
import type { SourceFile, StatementSource } from "./types";
import { MAX_STATEMENT_BYTES } from "./driveSource";

/** More than this share of unmatched lines after an auto-reconcile is surfaced for a human. */
export const UNMATCHED_REVIEW_RATIO = 0.5;
/** A claimed file with no outcome after this long was interrupted (crash/deploy). */
export const STALE_PROCESSING_MS = 30 * 60 * 1000;

export type IngestOutcome = "skipped_seen" | StatementIngestFile["status"];

export interface IngestDeps {
  storeFile: (content: Buffer, fileName: string, orgId: string) => Promise<string>;
  reconcile: typeof reconcileStatement;
}

const defaultDeps: IngestDeps = {
  storeFile: (content, fileName, orgId) =>
    new ObjectStorageService().uploadDocument(content, fileName, orgId, { contentType: "text/csv" }),
  reconcile: reconcileStatement,
};

/** A safe, PHI-free description of an error. */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? `${err.name} (${code})` : err.name;
  }
  return "Unknown error";
}

async function settle(
  id: string,
  status: StatementIngestFile["status"],
  patch: Partial<Pick<StatementIngestFile, "reason" | "statementId" | "lineCount" | "matchedCount" | "unmatchedCount">> = {},
): Promise<StatementIngestFile["status"]> {
  await db.update(statementIngestFilesTable).set({ status, ...patch }).where(eq(statementIngestFilesTable.id, id));
  return status;
}

export async function ingestFile(
  source: StatementIngestSource,
  file: SourceFile,
  from: StatementSource,
  deps: IngestDeps = defaultDeps,
): Promise<IngestOutcome> {
  // 1. CLAIM
  const ledgerId = randomUUID();
  const [claimed] = await db
    .insert(statementIngestFilesTable)
    .values({
      id: ledgerId,
      orgId: source.orgId,
      sourceId: source.id,
      externalId: file.externalId,
      checksum: file.checksum,
      fileName: file.name,
      folderName: file.folderName,
      status: "processing",
    })
    .onConflictDoNothing()
    .returning({ id: statementIngestFilesTable.id });
  if (!claimed) return "skipped_seen";

  try {
    // 2. CHECK: what is this file?
    if (!isSupportedStatementFile(file.name) || !file.downloadable) {
      return await settle(ledgerId, "needs_review", {
        reason: "Unsupported file type: only CSV or pipe-delimited text statements can be read automatically",
      });
    }
    if (file.sizeBytes != null && file.sizeBytes > MAX_STATEMENT_BYTES) {
      return await settle(ledgerId, "needs_review", { reason: "File is larger than the 50 MB limit" });
    }

    const carriers = await db
      .select({ id: carriersTable.id, name: carriersTable.name, isActive: carriersTable.isActive })
      .from(carriersTable)
      .where(eq(carriersTable.orgId, source.orgId));
    const carrierResult = inferCarrier(
      carriers,
      { folderName: file.folderName, fileName: file.name },
      source.carrierFolderMap,
    );
    if (!carrierResult.ok) return await settle(ledgerId, "needs_review", { reason: carrierResult.reason });
    const carrier = carrierResult.carrier;

    const content = await from.download(file);

    let lines: NormalizedLineItem[];
    try {
      lines = parseStatement(carrier.name, content);
    } catch (err) {
      if (err instanceof UnknownCarrierError) {
        return await settle(ledgerId, "needs_review", { reason: `No statement parser for ${carrier.name}` });
      }
      logger.warn({ errName: describeError(err), orgId: source.orgId, ledgerId }, "Statement ingest: parse failed");
      return await settle(ledgerId, "failed", { reason: `Could not parse the file: ${describeError(err)}` });
    }
    if (lines.length === 0) {
      return await settle(ledgerId, "needs_review", { reason: "The file parsed but contained no commission lines" });
    }

    const period = inferPeriod(file.name, lines);
    if (!period) {
      return await settle(ledgerId, "needs_review", {
        lineCount: lines.length,
        reason: "Could not tell the statement period from the filename or the lines",
      });
    }

    const [duplicate] = await db
      .select({ id: commissionStatementsTable.id })
      .from(commissionStatementsTable)
      .where(
        and(
          eq(commissionStatementsTable.orgId, source.orgId),
          eq(commissionStatementsTable.carrierId, carrier.id),
          eq(commissionStatementsTable.periodStart, period.periodStart),
          eq(commissionStatementsTable.periodEnd, period.periodEnd),
        ),
      )
      .limit(1);
    if (duplicate) {
      return await settle(ledgerId, "needs_review", {
        lineCount: lines.length,
        reason: `A ${carrier.name} statement for ${period.periodStart} to ${period.periodEnd} already exists; this may be a corrected re-issue`,
      });
    }

    // 3. STORE
    const storageKey = await deps.storeFile(content, file.name, source.orgId);

    // 4. CREATE: statement + lines together or not at all
    const statementId = randomUUID();
    await db.transaction(async (tx) => {
      await tx.insert(commissionStatementsTable).values({
        id: statementId,
        orgId: source.orgId,
        carrierId: carrier.id,
        statementDate: inferStatementDate(file.name, file.modifiedTime, period),
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        // The files carry no carrier-stated total, so none is recorded. Writing the
        // sum of the lines here would make the variance check always pass.
        totalAmount: null,
        currency: "USD",
        // The table's CHECK allows csv_upload | manual | api. "api" = automated intake;
        // which file it came from is recorded in statement_ingest_files.statement_id.
        source: "api",
        storageKey,
        status: "parsed",
        uploadedByUserId: null,
      });
      await insertLineItems(tx, statementId, source.orgId, lines);
    });

    // 5. RECONCILE (auto) or HOLD
    if (source.mode === "hold") {
      return await settle(ledgerId, "held", { statementId, lineCount: lines.length });
    }
    return await reconcileAndSettle(ledgerId, statementId, source.orgId, lines.length, deps);
  } catch (err) {
    logger.error({ errName: describeError(err), orgId: source.orgId, ledgerId }, "Statement ingest: file failed");
    await settle(ledgerId, "failed", { reason: `Unexpected error: ${describeError(err)}` });
    return "failed";
  }
}

async function reconcileAndSettle(
  ledgerId: string,
  statementId: string,
  orgId: string,
  lineCount: number,
  deps: IngestDeps,
): Promise<StatementIngestFile["status"]> {
  const result = await deps.reconcile(statementId, orgId);
  const counts = { statementId, lineCount, matchedCount: result.matched, unmatchedCount: result.unmatched };
  const total = result.matched + result.unmatched;
  if (total > 0 && result.unmatched / total > UNMATCHED_REVIEW_RATIO) {
    return settle(ledgerId, "needs_review", {
      ...counts,
      reason: `Reconciled, but ${result.unmatched} of ${total} lines did not match a client; check before paying out`,
    });
  }
  return settle(ledgerId, "ingested", counts);
}

/**
 * Approve a statement that was parsed but not yet reconciled: reconcile it now.
 * Returns null when the row is not approvable (not found, no statement was
 * created, or it is already being processed / done).
 */
export async function approveHeldFile(
  orgId: string,
  ledgerId: string,
  deps: IngestDeps = defaultDeps,
): Promise<StatementIngestFile["status"] | null> {
  // Atomic claim so a double-click cannot reconcile twice.
  const [row] = await db
    .update(statementIngestFilesTable)
    .set({ status: "processing" })
    .where(
      and(
        eq(statementIngestFilesTable.id, ledgerId),
        eq(statementIngestFilesTable.orgId, orgId),
        inArray(statementIngestFilesTable.status, ["held", "needs_review"]),
        isNotNull(statementIngestFilesTable.statementId),
      ),
    )
    .returning();
  if (!row?.statementId) return null;
  try {
    const result = await deps.reconcile(row.statementId, orgId);
    return await settle(row.id, "approved", {
      matchedCount: result.matched,
      unmatchedCount: result.unmatched,
      reason: null,
    });
  } catch (err) {
    logger.error({ errName: describeError(err), orgId, ledgerId }, "Statement ingest: approve failed");
    return settle(row.id, "failed", { reason: `Reconcile failed: ${describeError(err)}` });
  }
}
