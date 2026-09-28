/**
 * Agent Back Office (stage 2, read-only composition).
 *
 *   GET /agents/me/backoffice   — the caller's own agent record (any role
 *                                 with a linked agent row, including `agent`)
 *   GET /agents/:id/backoffice  — any agent in the org (needs `agent:read`)
 *
 * One call returns everything the back-office page shows: profile basics,
 * ready-to-sell status and blockers, the compliance score, AHIP, licenses,
 * carrier certifications, carrier portal / tech-stack accounts, open tasks,
 * the agent's own documents and onboarding checklists.
 *
 * Authorization mirrors the existing surfaces: the `/me` path resolves the
 * agent by (userId, orgId) exactly like `GET /commissions/me`, so an agent can
 * only ever see themselves; the `/:id` path is `agent:read` + org-scoped.
 * Contracting PII (SSN/EIN/DOB) is never read here.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  agentsTable,
  stateLicensesTable,
  carrierCertificationsTable,
  carriersTable,
  ahipRecordsTable,
  techStackAccountsTable,
  taskInstancesTable,
  documentsTable,
  checklistRunsTable,
  checklistItemsTable,
} from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { withEffectiveStatus } from "../lib/licenses/licenseStatus";
import { getOrgReadiness } from "../lib/agents/readiness";
import { getAgentComplianceScores } from "../lib/compliance/agentComplianceScore";

const router: IRouter = Router();

type AgentRow = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  status: string;
  hireDate: Date | null;
  npn: string | null;
  avatarUrl: string | null;
};

const agentColumns = {
  id: agentsTable.id,
  firstName: agentsTable.firstName,
  lastName: agentsTable.lastName,
  email: agentsTable.email,
  phone: agentsTable.phone,
  status: agentsTable.status,
  hireDate: agentsTable.hireDate,
  npn: agentsTable.npn,
  avatarUrl: agentsTable.avatarUrl,
};

async function buildBackoffice(agent: AgentRow, orgId: string) {
  const now = new Date();
  const [readiness, score, ahip, licenses, certifications, portals, tasks, documents, runs] =
    await Promise.all([
      // Plan year being sold (lib/compliance/planYear.ts), same as the score.
      getOrgReadiness(orgId, undefined, now),
      // The one compliance score (lib/compliance/agentComplianceScore.ts).
      getAgentComplianceScores({ orgId, agentIds: [agent.id], now }).then(([s]) => {
        const { licensesExpiringSoon: _soon, ...rest } = s;
        return rest;
      }),
      db
        .select({
          id: ahipRecordsTable.id,
          certificationYear: ahipRecordsTable.certificationYear,
          status: ahipRecordsTable.status,
          score: ahipRecordsTable.score,
          completedDate: ahipRecordsTable.completedDate,
        })
        .from(ahipRecordsTable)
        .where(eq(ahipRecordsTable.agentId, agent.id))
        .orderBy(desc(ahipRecordsTable.certificationYear))
        .limit(5),
      db
        .select({
          id: stateLicensesTable.id,
          stateCode: stateLicensesTable.stateCode,
          licenseType: stateLicensesTable.licenseType,
          status: stateLicensesTable.status,
          expiryDate: stateLicensesTable.expiryDate,
        })
        .from(stateLicensesTable)
        .where(eq(stateLicensesTable.agentId, agent.id))
        .orderBy(asc(stateLicensesTable.stateCode)),
      db
        .select({
          id: carrierCertificationsTable.id,
          carrierId: carrierCertificationsTable.carrierId,
          carrierName: carriersTable.name,
          certificationYear: carrierCertificationsTable.certificationYear,
          status: carrierCertificationsTable.status,
          completedDate: carrierCertificationsTable.completedDate,
          expiryDate: carrierCertificationsTable.expiryDate,
        })
        .from(carrierCertificationsTable)
        .leftJoin(
          carriersTable,
          and(eq(carriersTable.id, carrierCertificationsTable.carrierId), eq(carriersTable.orgId, orgId)),
        )
        .where(eq(carrierCertificationsTable.agentId, agent.id))
        .orderBy(desc(carrierCertificationsTable.certificationYear), asc(carriersTable.name)),
      db
        .select({
          id: techStackAccountsTable.id,
          platformName: techStackAccountsTable.platformName,
          platformCategory: techStackAccountsTable.platformCategory,
          status: techStackAccountsTable.status,
          provisionedAt: techStackAccountsTable.provisionedAt,
        })
        .from(techStackAccountsTable)
        .where(eq(techStackAccountsTable.agentId, agent.id))
        .orderBy(asc(techStackAccountsTable.platformName)),
      db
        .select({
          id: taskInstancesTable.id,
          title: taskInstancesTable.title,
          dueDate: taskInstancesTable.dueDate,
          priority: taskInstancesTable.priority,
          status: taskInstancesTable.status,
        })
        .from(taskInstancesTable)
        .where(
          and(
            eq(taskInstancesTable.orgId, orgId),
            eq(taskInstancesTable.agentId, agent.id),
            inArray(taskInstancesTable.status, ["open", "in_progress"]),
          ),
        )
        .orderBy(sql`${taskInstancesTable.dueDate} ASC NULLS LAST`, desc(taskInstancesTable.createdAt))
        .limit(50),
      db
        .select({
          id: documentsTable.id,
          name: documentsTable.name,
          category: documentsTable.category,
          createdAt: documentsTable.createdAt,
        })
        .from(documentsTable)
        .where(
          and(
            eq(documentsTable.orgId, orgId),
            eq(documentsTable.agentId, agent.id),
            // The agent's own paperwork only — never client documents.
            isNull(documentsTable.contactId),
          ),
        )
        .orderBy(desc(documentsTable.createdAt))
        .limit(50),
      db
        .select({
          id: checklistRunsTable.id,
          type: checklistRunsTable.type,
          status: checklistRunsTable.status,
          startedAt: checklistRunsTable.startedAt,
          completedAt: checklistRunsTable.completedAt,
        })
        .from(checklistRunsTable)
        .where(and(eq(checklistRunsTable.orgId, orgId), eq(checklistRunsTable.agentId, agent.id)))
        .orderBy(desc(checklistRunsTable.startedAt))
        .limit(10),
    ]);

  const runIds = runs.map((r) => r.id);
  const itemCounts = runIds.length
    ? await db
        .select({
          runId: checklistItemsTable.runId,
          total: sql<number>`count(*)::int`,
          done: sql<number>`count(*) FILTER (WHERE ${checklistItemsTable.status} IN ('completed','skipped'))::int`,
        })
        .from(checklistItemsTable)
        .where(inArray(checklistItemsTable.runId, runIds))
        .groupBy(checklistItemsTable.runId)
    : [];
  const countsByRun = new Map(itemCounts.map((c) => [c.runId, c]));

  const mine = readiness.agents.find((a) => a.agentId === agent.id) ?? null;

  return {
    agent,
    readiness: mine
      ? {
          readyToSell: mine.readyToSell,
          blockers: mine.blockers,
          ahipCurrent: mine.ahipCurrent,
          licensedStates: mine.licensedStates,
          certifiedCarriers: mine.certifiedCarriers,
          certificationYear: readiness.certificationYear,
        }
      : null,
    complianceScore: score,
    ahip,
    licenses: licenses.map((l) => withEffectiveStatus(l, now)),
    certifications,
    portals,
    tasks,
    documents,
    checklists: runs.map((r) => ({
      ...r,
      totalItems: Number(countsByRun.get(r.id)?.total ?? 0),
      completedItems: Number(countsByRun.get(r.id)?.done ?? 0),
    })),
    asOf: now.toISOString(),
  };
}

router.get(
  "/agents/me/backoffice",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const [agent] = await db
      .select(agentColumns)
      .from(agentsTable)
      .where(and(eq(agentsTable.userId, authReq.userId), eq(agentsTable.orgId, authReq.orgId)))
      .limit(1);
    if (!agent) {
      res.status(404).json({ error: "No agent record is linked to your account." });
      return;
    }
    res.json(await buildBackoffice(agent, authReq.orgId));
  },
);

router.get(
  "/agents/:id/backoffice",
  requireAuth,
  requirePermission("agent", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [agent] = await db
      .select(agentColumns)
      .from(agentsTable)
      .where(and(eq(agentsTable.id, id ?? ""), eq(agentsTable.orgId, authReq.orgId)))
      .limit(1);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    res.json(await buildBackoffice(agent, authReq.orgId));
  },
);

export default router;
