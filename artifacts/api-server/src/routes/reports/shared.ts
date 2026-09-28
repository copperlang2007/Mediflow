import { type Request } from "express";
import { db, dataExportLogTable } from "@workspace/db";
import { randomUUID } from "crypto";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Report date range from `?startDate=&endDate=`.
 *
 * The web app sends plain calendar dates ("2026-09-27"). `new Date("2026-09-27")`
 * is MIDNIGHT UTC at the START of that day, so an end date of "today" used to
 * exclude everything created today — which is why Reports → Executive said
 * "New Leads 0" on a freshly seeded agency. A date-only `endDate` now means the
 * END of that day (23:59:59.999 UTC), i.e. the range is inclusive. Full
 * timestamps are used as given.
 */
export function parseRange(req: Request) {
  const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };
  let end = endDate ? new Date(endDate) : new Date();
  if (endDate && DATE_ONLY.test(endDate) && !Number.isNaN(end.getTime())) {
    end = new Date(end.getTime() + 24 * 60 * 60 * 1000 - 1);
  }
  const start = startDate ? new Date(startDate) : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { start, end };
}

export async function logExport(orgId: string, userId: string | null, exportType: string, filters: unknown, recordCount: number) {
  await db.insert(dataExportLogTable).values({
    id: randomUUID(),
    orgId,
    userId: userId ?? undefined,
    exportType,
    filters: filters as Record<string, unknown>,
    recordCount,
  });
}
