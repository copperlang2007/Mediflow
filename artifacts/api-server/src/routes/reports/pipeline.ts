import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, gte, lte } from "drizzle-orm";
import {
  db,
  dealsTable,
  pipelinesTable,
  pipelineStagesTable,
  dealStageHistoryTable,
} from "@workspace/db";
import {
  requireAuth,
  requireRole,
  type AuthenticatedRequest,
  requireExportConfirm,
} from "../../middlewares/requireAuth";
import { parseRange, logExport } from "./shared";

const router: IRouter = Router();

// ─── Pipeline Report ──────────────────────────────────────────────────────────
router.get(
  "/reports/pipeline",
  requireAuth,
  requireRole("super_admin", "agency_admin", "compliance_manager", "agent_support"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { start, end } = parseRange(req);

    const [pipelines, stages, deals, stageHistory] = await Promise.all([
      db.select().from(pipelinesTable).where(eq(pipelinesTable.orgId, authReq.orgId)),
      db.select().from(pipelineStagesTable).innerJoin(pipelinesTable, eq(pipelineStagesTable.pipelineId, pipelinesTable.id))
        .where(eq(pipelinesTable.orgId, authReq.orgId)),
      db.select().from(dealsTable)
        .where(and(eq(dealsTable.orgId, authReq.orgId), gte(dealsTable.createdAt, start), lte(dealsTable.createdAt, end))),
      // Stage history: for avg-time-in-stage and conversion rates
      db.select({
        dealId: dealStageHistoryTable.dealId,
        fromStageId: dealStageHistoryTable.fromStageId,
        toStageId: dealStageHistoryTable.toStageId,
        changedAt: dealStageHistoryTable.changedAt,
      })
        .from(dealStageHistoryTable)
        .innerJoin(dealsTable, eq(dealStageHistoryTable.dealId, dealsTable.id))
        .where(and(eq(dealsTable.orgId, authReq.orgId), gte(dealsTable.createdAt, start), lte(dealsTable.createdAt, end))),
    ]);

    // Build a map: dealId → sorted history entries by changedAt
    const historyByDeal = new Map<string, Array<{ fromStageId: string | null; toStageId: string | null; changedAt: Date }>>();
    for (const h of stageHistory) {
      if (!historyByDeal.has(h.dealId)) historyByDeal.set(h.dealId, []);
      historyByDeal.get(h.dealId)!.push({ fromStageId: h.fromStageId, toStageId: h.toStageId, changedAt: h.changedAt });
    }
    for (const entries of historyByDeal.values()) {
      entries.sort((a, b) => a.changedAt.getTime() - b.changedAt.getTime());
    }

    // Per-stage avg time spent (ms), computed from history transitions
    function avgTimeInStage(stageId: string, pipelineDeals: typeof deals): number {
      const durations: number[] = [];
      for (const deal of pipelineDeals) {
        const history = historyByDeal.get(deal.id) ?? [];
        // Find when this deal entered the stage and when it left
        let enteredAt: Date | null = null;
        if (deal.stageId === stageId && history.length === 0) {
          // Deal still in stage, no history — use deal.createdAt as proxy
          enteredAt = deal.createdAt;
        }
        for (let idx = 0; idx < history.length; idx++) {
          const h = history[idx];
          if (h.toStageId === stageId) enteredAt = h.changedAt;
          if (h.fromStageId === stageId && enteredAt) {
            durations.push(h.changedAt.getTime() - enteredAt.getTime());
            enteredAt = null;
          }
        }
        // If still in stage (no exit found)
        if (enteredAt && deal.stageId === stageId) {
          durations.push(Date.now() - enteredAt.getTime());
        }
      }
      if (durations.length === 0) return 0;
      return Math.round(durations.reduce((s, d) => s + d, 0) / durations.length / (60 * 60 * 1000)); // hours
    }

    // Conversion rate: % of deals that moved from this stage to the next ordered stage
    function conversionRate(stageId: string, nextStageId: string | null, pipelineDeals: typeof deals): number {
      if (!nextStageId) return 0;
      let entered = 0, advanced = 0;
      for (const deal of pipelineDeals) {
        const history = historyByDeal.get(deal.id) ?? [];
        const passedThisStage = deal.stageId === stageId || history.some((h) => h.fromStageId === stageId || h.toStageId === stageId);
        if (!passedThisStage) continue;
        entered++;
        if (history.some((h) => h.fromStageId === stageId && h.toStageId === nextStageId)) advanced++;
      }
      return entered > 0 ? Math.round((advanced / entered) * 1000) / 10 : 0;
    }

    // Bucket stages and deals by pipeline once instead of filtering N times.
    const stagesByPipeline = new Map<string, Array<typeof stages[number]["pipeline_stages"]>>();
    for (const s of stages) {
      const pid = s.pipeline_stages.pipelineId;
      const arr = stagesByPipeline.get(pid);
      if (arr) arr.push(s.pipeline_stages); else stagesByPipeline.set(pid, [s.pipeline_stages]);
    }
    const dealsByPipeline = new Map<string, typeof deals>();
    for (const d of deals) {
      if (!d.pipelineId) continue;
      const arr = dealsByPipeline.get(d.pipelineId);
      if (arr) arr.push(d); else dealsByPipeline.set(d.pipelineId, [d]);
    }

    const pipelineReport = pipelines.map((p) => {
      const pStages = (stagesByPipeline.get(p.id) ?? [])
        .slice()
        .sort((a, b) => a.orderIndex - b.orderIndex);

      const pDeals = dealsByPipeline.get(p.id) ?? [];

      const funnel = pStages.map((stage, idx) => {
        const nextStage = pStages[idx + 1] ?? null;
        const stageDeals = pDeals.filter((d) => d.stageId === stage.id);
        const won = pDeals.filter((d) => d.status === "won" && d.stageId === stage.id).length;
        const lost = pDeals.filter((d) => d.status === "lost" && d.stageId === stage.id).length;
        return {
          stageId: stage.id,
          stageName: stage.name,
          orderIndex: stage.orderIndex,
          dealCount: stageDeals.length,
          totalValue: stageDeals.reduce((s, d) => s + (d.valueEst ?? 0), 0),
          wonCount: won,
          lostCount: lost,
          conversionRate: conversionRate(stage.id, nextStage?.id ?? null, pDeals),
          avgTimeInStageHours: avgTimeInStage(stage.id, pDeals),
        };
      });

      const totalDeals = pDeals.length;
      const wonDeals = pDeals.filter((d) => d.status === "won").length;
      const lostDeals = pDeals.filter((d) => d.status === "lost").length;
      const totalWonValue = pDeals.filter((d) => d.status === "won").reduce((s, d) => s + (d.valueEst ?? 0), 0);

      // Per-agent breakdown of won deals in this pipeline
      const agentBreakdown: Record<string, { agentId: string; wonCount: number; totalValue: number }> = {};
      for (const deal of pDeals.filter((d) => d.status === "won" && d.assignedAgentId)) {
        const aid = deal.assignedAgentId!;
        if (!agentBreakdown[aid]) agentBreakdown[aid] = { agentId: aid, wonCount: 0, totalValue: 0 };
        agentBreakdown[aid].wonCount++;
        agentBreakdown[aid].totalValue += deal.valueEst ?? 0;
      }
      const byAgent = Object.values(agentBreakdown).sort((a, b) => b.wonCount - a.wonCount).slice(0, 10);

      return {
        pipelineId: p.id,
        pipelineName: p.name,
        totalDeals,
        wonDeals,
        lostDeals,
        winRate: totalDeals > 0 ? Math.round((wonDeals / totalDeals) * 1000) / 10 : 0,
        totalWonValue,
        funnel,
        byAgent,
      };
    });

    res.json(pipelineReport);
  },
);

// ─── Pipeline CSV Export ──────────────────────────────────────────────────────
router.get(
  "/reports/pipeline/export",
  requireAuth,
  requireRole("super_admin", "agency_admin", "compliance_manager"),
  requireExportConfirm,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { start, end } = parseRange(req);

    // Run pipelines + deals in parallel; stages join on pipelines via the table itself,
    // so it doesn't need the pipeline IDs from the JS side — also runs in parallel.
    const [pipelines, allDeals, stagesJoined] = await Promise.all([
      db.select({ id: pipelinesTable.id, name: pipelinesTable.name })
        .from(pipelinesTable).where(eq(pipelinesTable.orgId, authReq.orgId)),

      db.select({
        pipelineId: dealsTable.pipelineId,
        stageId: dealsTable.stageId,
        status: dealsTable.status,
        value: dealsTable.valueEst,
      }).from(dealsTable)
        .where(and(eq(dealsTable.orgId, authReq.orgId), gte(dealsTable.createdAt, start), lte(dealsTable.createdAt, end))),

      db.select({ id: pipelineStagesTable.id, pipelineId: pipelineStagesTable.pipelineId, name: pipelineStagesTable.name })
        .from(pipelineStagesTable)
        .innerJoin(pipelinesTable, eq(pipelineStagesTable.pipelineId, pipelinesTable.id))
        .where(eq(pipelinesTable.orgId, authReq.orgId)),
    ]);
    const stages = stagesJoined;

    const stageMap: Record<string, string> = {};
    for (const s of stages) stageMap[s.id] = s.name;
    const pipelineMap: Record<string, string> = {};
    for (const p of pipelines) pipelineMap[p.id] = p.name;

    type StageRow = { pipeline: string; stage: string; active: number; won: number; lost: number; wonValue: number };
    const rowMap: Record<string, StageRow> = {};
    for (const d of allDeals) {
      const key = `${d.pipelineId}::${d.stageId}`;
      if (!rowMap[key]) rowMap[key] = { pipeline: pipelineMap[d.pipelineId ?? ""] ?? "", stage: stageMap[d.stageId ?? ""] ?? "", active: 0, won: 0, lost: 0, wonValue: 0 };
      if (d.status === "won") { rowMap[key].won++; rowMap[key].wonValue += Number(d.value ?? 0); }
      else if (d.status === "lost") rowMap[key].lost++;
      else rowMap[key].active++;
    }

    const header = ["Pipeline", "Stage", "Active Deals", "Won", "Lost", "Won Value ($)"];
    const rows = Object.values(rowMap).map((r) => [r.pipeline, r.stage, r.active, r.won, r.lost, r.wonValue.toFixed(2)]);
    const csv = [header, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");

    await logExport(authReq.orgId, authReq.userId, "pipeline_csv", { startDate: start, endDate: end }, rows.length);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="pipeline-report-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  },
);

export default router;
