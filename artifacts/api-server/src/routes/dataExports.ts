/**
 * Whole-book CSV exports for the Data Tools page (stage 2).
 *
 *   GET /reports/contacts/export  — every (non-deleted) contact
 *   GET /reports/policies/export  — every enrollment ("policy")
 *   GET /reports/agents/export    — the agent roster
 *
 * Same pattern and safeguards as the existing `/reports/*\/export` routes and
 * the contacts bulk `export_csv` action:
 *   - `requireExportConfirm` (recent sign-in + `X-Confirm-Export: true`);
 *   - a `data_export_log` row per export, so the export-anomaly worker sees it;
 *   - org-scoped queries only.
 *
 * PHI handling is IDENTICAL to the existing contacts export:
 *   - contacts go through `serializeContact`, so the Medicare ID is decrypted
 *     only for PHI-privileged roles and masked (`***-**-****`) for everyone
 *     else; DOB and health conditions are never included in the columns;
 *   - the permission is the same one the bulk export requires
 *     (`contact:update`).
 * The policies export carries no Medicare ID at all, and the agent export
 * never touches contracting PII (SSN / EIN / DOB).
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import {
  db,
  contactsTable,
  enrollmentsTable,
  carriersTable,
  agentsTable,
} from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  requireExportConfirm,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { serializeContact } from "../lib/serializeContact";
import { logExport } from "./reports/shared";

const router: IRouter = Router();

/** Upper bound on rows per export — protects the server, recorded when hit. */
export const EXPORT_ROW_CAP = 25_000;

function csvCell(v: unknown): string {
  if (v == null) return '""';
  const s = v instanceof Date ? v.toISOString() : String(v);
  // Neutralise spreadsheet formula injection (=, +, -, @ at the start).
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

function toCsv(header: string[], rows: unknown[][]): string {
  return [header.map(csvCell).join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n");
}

function sendCsv(res: Response, name: string, csv: string, truncated: boolean): void {
  res.setHeader("Content-Type", "text/csv");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"`,
  );
  if (truncated) res.setHeader("X-Export-Truncated", "true");
  res.send(csv);
}

// Same column set as the contacts bulk `export_csv` action.
const CONTACT_HEADERS = [
  "id", "firstName", "lastName", "email", "phone", "status", "medicareId",
  "currentPlanType", "stateCode", "zipCode", "leadSource", "createdAt",
] as const;

router.get(
  "/reports/contacts/export",
  requireAuth,
  requirePermission("contact", "update"),
  requireExportConfirm,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const rows = await db
      .select()
      .from(contactsTable)
      .where(and(eq(contactsTable.orgId, authReq.orgId), isNull(contactsTable.deletedAt)))
      .orderBy(asc(contactsTable.lastName), asc(contactsTable.firstName), asc(contactsTable.id))
      .limit(EXPORT_ROW_CAP + 1);
    const truncated = rows.length > EXPORT_ROW_CAP;
    const masked = rows.slice(0, EXPORT_ROW_CAP).map((c) => serializeContact(c, authReq.userRole));
    const csv = toCsv(
      [...CONTACT_HEADERS],
      masked.map((c) => CONTACT_HEADERS.map((h) => (c as Record<string, unknown>)[h])),
    );

    await logExport(authReq.orgId, authReq.userId, "contacts_csv", { scope: "all", truncated }, masked.length);
    sendCsv(res, "contacts", csv, truncated);
  },
);

router.get(
  "/reports/policies/export",
  requireAuth,
  requirePermission("contact", "update"),
  requireExportConfirm,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const rows = await db
      .select({
        id: enrollmentsTable.id,
        contactId: enrollmentsTable.contactId,
        contactFirstName: contactsTable.firstName,
        contactLastName: contactsTable.lastName,
        carrierName: carriersTable.name,
        planType: enrollmentsTable.planType,
        planName: enrollmentsTable.planName,
        planId: enrollmentsTable.planId,
        planYear: enrollmentsTable.planYear,
        policyNumber: enrollmentsTable.policyNumber,
        applicationDate: enrollmentsTable.applicationDate,
        effectiveDate: enrollmentsTable.effectiveDate,
        effectuated: enrollmentsTable.effectuated,
        status: enrollmentsTable.status,
        disenrolledDate: enrollmentsTable.disenrolledDate,
        agentFirstName: agentsTable.firstName,
        agentLastName: agentsTable.lastName,
      })
      .from(enrollmentsTable)
      .leftJoin(
        contactsTable,
        and(eq(contactsTable.id, enrollmentsTable.contactId), eq(contactsTable.orgId, authReq.orgId)),
      )
      .leftJoin(
        carriersTable,
        and(eq(carriersTable.id, enrollmentsTable.carrierId), eq(carriersTable.orgId, authReq.orgId)),
      )
      .leftJoin(
        agentsTable,
        and(eq(agentsTable.id, enrollmentsTable.agentId), eq(agentsTable.orgId, authReq.orgId)),
      )
      .where(eq(enrollmentsTable.orgId, authReq.orgId))
      .orderBy(desc(enrollmentsTable.planYear), desc(enrollmentsTable.effectiveDate), asc(enrollmentsTable.id))
      .limit(EXPORT_ROW_CAP + 1);
    const truncated = rows.length > EXPORT_ROW_CAP;
    const kept = rows.slice(0, EXPORT_ROW_CAP);

    const header = [
      "policyId", "contactId", "clientName", "carrier", "planType", "planName", "planId",
      "planYear", "policyNumber", "applicationDate", "effectiveDate", "effectuated",
      "status", "disenrolledDate", "writingAgent",
    ];
    const csv = toCsv(
      header,
      kept.map((r) => [
        r.id,
        r.contactId,
        `${r.contactFirstName ?? ""} ${r.contactLastName ?? ""}`.trim(),
        r.carrierName,
        r.planType,
        r.planName,
        r.planId,
        r.planYear,
        r.policyNumber,
        r.applicationDate,
        r.effectiveDate,
        r.effectuated ? "yes" : "no",
        r.status,
        r.disenrolledDate,
        `${r.agentFirstName ?? ""} ${r.agentLastName ?? ""}`.trim(),
      ]),
    );

    await logExport(authReq.orgId, authReq.userId, "policies_csv", { scope: "all", truncated }, kept.length);
    sendCsv(res, "policies", csv, truncated);
  },
);

router.get(
  "/reports/agents/export",
  requireAuth,
  // Same audience as the existing agent-performance export
  // (super_admin, agency_admin, compliance_manager).
  requirePermission("agent", "update"),
  requireExportConfirm,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const rows = await db
      .select({
        id: agentsTable.id,
        firstName: agentsTable.firstName,
        lastName: agentsTable.lastName,
        email: agentsTable.email,
        phone: agentsTable.phone,
        npn: agentsTable.npn,
        status: agentsTable.status,
        hireDate: agentsTable.hireDate,
        createdAt: agentsTable.createdAt,
      })
      .from(agentsTable)
      .where(eq(agentsTable.orgId, authReq.orgId))
      .orderBy(asc(agentsTable.lastName), asc(agentsTable.firstName), asc(agentsTable.id))
      .limit(EXPORT_ROW_CAP + 1);
    const truncated = rows.length > EXPORT_ROW_CAP;
    const kept = rows.slice(0, EXPORT_ROW_CAP);

    const header = ["id", "firstName", "lastName", "email", "phone", "npn", "status", "hireDate", "createdAt"];
    const csv = toCsv(
      header,
      kept.map((a) => [a.id, a.firstName, a.lastName, a.email, a.phone, a.npn, a.status, a.hireDate, a.createdAt]),
    );

    await logExport(authReq.orgId, authReq.userId, "agents_csv", { scope: "all", truncated }, kept.length);
    sendCsv(res, "agents", csv, truncated);
  },
);

export default router;
