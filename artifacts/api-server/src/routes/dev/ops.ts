/**
 * Dev console ops endpoints — read-only operational visibility.
 *
 * These routes back the /dev/ops dashboard in the web app. They are
 * intentionally not added to the OpenAPI spec so we don't pollute the
 * generated client; consumers should call them via plain customFetch.
 *
 * The whole sub-router is gated by `devOnly` (env var) and additionally
 * requires `dev_console:read` so a leaked env var alone isn't enough.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { sql, eq, and, desc, inArray } from "drizzle-orm";
import { db, automationRulesTable, automationRuleLogsTable } from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../../middlewares/requireAuth";
import { getQueue, JOB_NAMES, type JobName } from "../../lib/jobs";
import { logger } from "../../lib/logger";

const router: IRouter = Router();

// All dev endpoints require an authenticated user with dev_console read.
router.use(requireAuth, requirePermission("dev_console", "read"));

// GET /dev/ops/build — process build metadata.
router.get("/build", (_req: Request, res: Response): void => {
  res.json({
    commit: process.env.GIT_SHA ?? "unknown",
    builtAt: process.env.BUILD_TIME ?? "unknown",
    env: process.env.NODE_ENV ?? "unknown",
  });
});

// GET /dev/ops/queues — per-job queue summary.
//
// For each registered JOB_NAMES.*, returns:
//   - active:           jobs currently being processed (state='active')
//   - queued:           jobs waiting to run (state='created'/'retry')
//   - completedLast24h: archived completed jobs in the last 24h
//   - failedLast24h:    archived failed/cancelled jobs in the last 24h
//
// pg-boss v12 quirk: `getQueueSize(name)` returns the count of jobs in
// queued states only (created + retry); active jobs are NOT included. We
// therefore query the pgboss.job table directly to split active vs queued.
// Completion counts come from pgboss.archive, which is where pg-boss moves
// jobs after they finish (the live `job` table is truncated aggressively).
router.get("/queues", async (_req: Request, res: Response): Promise<void> => {
  try {
    await getQueue(); // ensure schema exists

    const jobNames = Object.values(JOB_NAMES) as JobName[];

    const liveRows = (await db.execute(
      sql`SELECT name, state, count(*)::int AS count
          FROM pgboss.job
          WHERE name = ANY(${jobNames as unknown as string[]})
          GROUP BY name, state`,
    )) as unknown as { rows: Array<{ name: string; state: string; count: number }> };

    const archiveRows = (await db.execute(
      sql`SELECT name, state, count(*)::int AS count
          FROM pgboss.archive
          WHERE name = ANY(${jobNames as unknown as string[]})
            AND completedon >= now() - interval '24 hours'
          GROUP BY name, state`,
    )) as unknown as { rows: Array<{ name: string; state: string; count: number }> };

    const summary = jobNames.map((name) => {
      let active = 0;
      let queued = 0;
      for (const row of liveRows.rows ?? []) {
        if (row.name !== name) continue;
        if (row.state === "active") active += Number(row.count);
        else if (row.state === "created" || row.state === "retry") {
          queued += Number(row.count);
        }
      }

      let completedLast24h = 0;
      let failedLast24h = 0;
      for (const row of archiveRows.rows ?? []) {
        if (row.name !== name) continue;
        if (row.state === "completed") completedLast24h += Number(row.count);
        else if (row.state === "failed" || row.state === "cancelled") {
          failedLast24h += Number(row.count);
        }
      }

      return { name, active, queued, completedLast24h, failedLast24h };
    });

    res.json({ queues: summary });
  } catch (err) {
    logger.error({ err }, "dev/ops/queues failed");
    res.status(500).json({ error: "Failed to read queue stats" });
  }
});

// GET /dev/ops/recent-errors — last 50 failed/partial automation runs.
//
// Mirrors the shape of /automations/recent-activity but filtered to errors
// and scoped to the calling user's org (auth-derived).
router.get("/recent-errors", async (req: Request, res: Response): Promise<void> => {
  const orgId = (req as AuthenticatedRequest).orgId;

  const recent = await db
    .select({
      id: automationRuleLogsTable.id,
      ruleId: automationRuleLogsTable.ruleId,
      ruleName: automationRulesTable.name,
      triggerType: automationRulesTable.triggerType,
      triggerEvent: automationRuleLogsTable.triggerEvent,
      matchedRecordType: automationRuleLogsTable.matchedRecordType,
      matchedRecordId: automationRuleLogsTable.matchedRecordId,
      actionsExecuted: automationRuleLogsTable.actionsExecuted,
      result: automationRuleLogsTable.result,
      errorMessage: automationRuleLogsTable.errorMessage,
      executedAt: automationRuleLogsTable.executedAt,
    })
    .from(automationRuleLogsTable)
    .innerJoin(
      automationRulesTable,
      eq(automationRuleLogsTable.ruleId, automationRulesTable.id),
    )
    .where(
      and(
        eq(automationRulesTable.orgId, orgId),
        inArray(automationRuleLogsTable.result, ["partial", "failed"]),
      ),
    )
    .orderBy(desc(automationRuleLogsTable.executedAt))
    .limit(50);

  res.json({ recent, total: recent.length });
});

// GET /dev/ops/workers — registered workers + last completion time.
//
// We use the latest pgboss.archive row with state='completed' per job name
// as a proxy for "last seen running". If a worker has never completed a
// job, lastSeen is null.
router.get("/workers", async (_req: Request, res: Response): Promise<void> => {
  try {
    await getQueue(); // ensure schema exists

    const jobNames = Object.values(JOB_NAMES) as JobName[];

    const rows = (await db.execute(
      sql`SELECT name, max(completedon) AS last_seen
          FROM pgboss.archive
          WHERE name = ANY(${jobNames as unknown as string[]})
            AND state = 'completed'
          GROUP BY name`,
    )) as unknown as { rows: Array<{ name: string; last_seen: string | null }> };

    const lastSeenByName = new Map<string, string | null>();
    for (const row of rows.rows ?? []) {
      lastSeenByName.set(row.name, row.last_seen);
    }

    const workers = jobNames.map((name) => ({
      name,
      lastSeen: lastSeenByName.get(name) ?? null,
    }));

    res.json({ workers });
  } catch (err) {
    logger.error({ err }, "dev/ops/workers failed");
    res.status(500).json({ error: "Failed to read worker stats" });
  }
});

export default router;
