/**
 * Supervisor desk — org-wide recent post-call summaries.
 *
 *   GET /supervisor/call-summaries?limit=20
 *
 * The in-platform parsed-transcript output (dialer Phase 5) across the whole
 * agency, newest first, so a supervisor can review calls without opening each
 * contact. Same data as `GET /contacts/:id/call-summaries` (PHI-minimized
 * summary, advisory disposition, risk flags, action items — never the MBI or a
 * raw transcript), plus the contact's and agent's names.
 *
 * Supervisor-tier only: `agent:admin` (super_admin / agency_admin) — the same
 * gate as the Live Queue oversight endpoints — AND `contact:read`, because the
 * rows name contacts.
 */
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db, agentsTable, contactsTable, dialTicketsTable } from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { can } from "../lib/permissions";
import type { TranscriptParseResult } from "../lib/dialer/transcriptParse";

const router: IRouter = Router();

const Query = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

function requireContactRead(req: Request, res: Response, next: NextFunction): void {
  const authReq = req as AuthenticatedRequest;
  if (!can(authReq.userRole, "contact", "read")) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}

router.get(
  "/supervisor/call-summaries",
  requireAuth,
  requirePermission("agent", "admin"),
  requireContactRead,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = Query.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.issues });
      return;
    }

    const rows = await db
      .select({
        ticketId: dialTicketsTable.id,
        status: dialTicketsTable.status,
        parsedAt: dialTicketsTable.transcriptParsedAt,
        createdAt: dialTicketsTable.createdAt,
        parsed: dialTicketsTable.transcriptParsed,
        contactId: contactsTable.id,
        contactFirstName: contactsTable.firstName,
        contactLastName: contactsTable.lastName,
        agentId: agentsTable.id,
        agentFirstName: agentsTable.firstName,
        agentLastName: agentsTable.lastName,
      })
      .from(dialTicketsTable)
      // Only tickets tied to a live contact in this org are shown.
      .innerJoin(
        contactsTable,
        and(
          eq(contactsTable.id, dialTicketsTable.contactRef),
          eq(contactsTable.orgId, authReq.orgId),
          isNull(contactsTable.deletedAt),
        ),
      )
      .leftJoin(
        agentsTable,
        and(
          eq(agentsTable.id, dialTicketsTable.agentId),
          eq(agentsTable.orgId, authReq.orgId),
        ),
      )
      .where(
        and(
          eq(dialTicketsTable.orgId, authReq.orgId),
          sql`${dialTicketsTable.transcriptParsed} IS NOT NULL`,
        ),
      )
      .orderBy(desc(dialTicketsTable.transcriptParsedAt), desc(dialTicketsTable.createdAt))
      .limit(parsed.data.limit ?? 20);

    const data = rows.map((r) => {
      const p = (r.parsed ?? {}) as Partial<TranscriptParseResult>;
      return {
        ticketId: r.ticketId,
        status: r.status,
        parsedAt: r.parsedAt,
        contact: {
          id: r.contactId,
          name: `${r.contactFirstName} ${r.contactLastName}`.trim(),
        },
        agent: r.agentId
          ? { id: r.agentId, name: `${r.agentFirstName ?? ""} ${r.agentLastName ?? ""}`.trim() }
          : null,
        summary: p.summary ?? null,
        suggestedDisposition: p.suggestedDisposition ?? null,
        riskFlags: p.riskFlags ?? [],
        actionItems: p.actionItems ?? [],
      };
    });

    res.set("Cache-Control", "no-store");
    res.json({ data, total: data.length });
  },
);

export default router;
