import { type Request } from "express";
import { db, dataExportLogTable } from "@workspace/db";
import { randomUUID } from "crypto";

export function parseRange(req: Request) {
  const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };
  const end = endDate ? new Date(endDate) : new Date();
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
