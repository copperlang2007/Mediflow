/**
 * Weekly Compliance Report Worker.
 *
 * Runs every Monday at 06:00 UTC. For each organization it builds a
 * deterministic compliance report from the database and:
 *  1. Renders it to PDF and persists it to object storage.
 *  2. Inserts a documentsTable record so it appears in the Document Library.
 *  3. Notifies all super_admin / agency_admin / compliance_manager users.
 *
 * The report of record is computed, not written by a model: every number comes
 * from a query below and is reproducible from the database on the report date.
 * Scores use the one canonical formula (lib/compliance/agentComplianceScore.ts)
 * and the plan year being sold (lib/compliance/planYear.ts).
 *
 * When a BAA-covered AI provider is configured, a short advisory commentary is
 * appended in its own clearly labelled section. It is optional: an AI outage
 * or misconfiguration never prevents the report from being produced, and the
 * commentary never replaces or edits the computed figures.
 */

import { and, eq, gt, inArray, isNotNull, like, lt, lte, notInArray, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  db,
  organizationsTable,
  agentsTable,
  stateLicensesTable,
  carrierCertificationsTable,
  carriersTable,
  taskInstancesTable,
  complaintsTable,
  documentsTable,
  notificationsTable,
  usersTable,
} from "@workspace/db";
import { buildAiClient } from "../lib/ai/buildAiClient";
import type { ChatCompletionClient } from "../lib/ai/bedrockAnthropicClient";
import { resolveAiModel } from "../lib/aiProvider";
import { ObjectStorageService } from "../lib/objectStorage";
import { buildComplianceReportPdf } from "../lib/complianceReportPdf";
import { logger } from "../lib/logger";
import {
  agencyComplianceScore,
  getAgentComplianceScores,
  type AgentComplianceScore,
} from "../lib/compliance/agentComplianceScore";

const storageService = new ObjectStorageService();

/** Agents scoring below this are listed as needing attention. */
export const ATTENTION_SCORE_THRESHOLD = 80;
const EXPIRY_WINDOW_DAYS = 90;

// The commentary is built from agent names + credential gaps, so it MUST go
// through the guarded construction every other AI path uses — buildAiClient,
// which hard-fails in production on a provider with no BAA.
let _aiClient: ChatCompletionClient | null | undefined;
function getAiClient(): ChatCompletionClient | null {
  if (_aiClient === undefined) _aiClient = buildAiClient();
  return _aiClient;
}

export interface WeeklyReportAgent {
  name: string;
  status: string;
  npn: string | null;
  score: AgentComplianceScore;
  overdueTasks: number;
}

export interface ExpiringCredential {
  agentName: string;
  label: string;
  expiryDate: Date;
}

export interface WeeklyReportData {
  reportDate: string;
  now: Date;
  planYear: number;
  agents: WeeklyReportAgent[];
  expiringLicenses: ExpiringCredential[];
  expiringCerts: ExpiringCredential[];
  complaints: { open: number; overdue: number; critical: number };
  openCallComplianceFindings: number;
}

const days = (from: Date, to: Date) => Math.ceil((to.getTime() - from.getTime()) / 86_400_000);
const fmtDate = (d: Date) => d.toISOString().slice(0, 10);

function agentGaps(a: WeeklyReportAgent, planYear: number): string[] {
  const s = a.score;
  const gaps: string[] = [];
  if (s.totalLicenses === 0) gaps.push("no state licenses on file");
  else if (s.activeLicenses < s.totalLicenses) {
    gaps.push(`${s.totalLicenses - s.activeLicenses} of ${s.totalLicenses} licenses not active`);
  }
  if (!s.ahipCompleted) gaps.push(`no ${planYear} AHIP`);
  if (s.totalCertifications === 0) gaps.push(`no ${planYear} carrier certifications`);
  else if (s.activeCertifications < s.totalCertifications) {
    gaps.push(`${s.totalCertifications - s.activeCertifications} of ${s.totalCertifications} ${planYear} certifications not passed`);
  }
  if (!a.npn) gaps.push("NPN missing");
  if (a.overdueTasks > 0) gaps.push(`${a.overdueTasks} overdue task${a.overdueTasks === 1 ? "" : "s"}`);
  return gaps;
}

/**
 * Render the report body. Pure — every line derives from `data` — so the same
 * inputs always produce the same report. Uses only the Markdown subset
 * buildComplianceReportPdf renders (##, -, ---, paragraphs).
 */
export function buildWeeklyComplianceMarkdown(data: WeeklyReportData): string {
  const { agents, planYear, now } = data;
  const active = agents.filter((a) => a.status === "active");
  const agencyScore = agencyComplianceScore(active.map((a) => a.score));
  const ahipDone = active.filter((a) => a.score.ahipCompleted).length;
  const attention = agents
    .filter((a) => a.score.totalScore < ATTENTION_SCORE_THRESHOLD || agentGaps(a, planYear).length > 0)
    .sort((a, b) => a.score.totalScore - b.score.totalScore);
  const good = agents.filter((a) => !attention.includes(a));

  const lines: string[] = [];
  lines.push(`Report date: ${data.reportDate}. Credentials are evaluated for plan year ${planYear}.`);
  lines.push("");
  lines.push("## Summary");
  lines.push(`- Agency compliance score (active agents): ${active.length > 0 ? `${agencyScore}/100` : "n/a — no active agents"}`);
  lines.push(`- Active agents: ${active.length}; onboarding agents: ${agents.length - active.length}`);
  lines.push(`- Active agents with ${planYear} AHIP: ${ahipDone} of ${active.length}`);
  lines.push(`- Agents needing attention: ${attention.length}`);
  lines.push(`- Licenses expiring in the next ${EXPIRY_WINDOW_DAYS} days: ${data.expiringLicenses.length}`);
  lines.push(`- Carrier certifications expiring in the next ${EXPIRY_WINDOW_DAYS} days: ${data.expiringCerts.length}`);
  lines.push(`- Open complaints: ${data.complaints.open} (${data.complaints.overdue} past resolution due date, ${data.complaints.critical} critical)`);
  lines.push(`- Open call-compliance findings from the dialer: ${data.openCallComplianceFindings}`);
  lines.push("");

  lines.push("## Agents needing attention");
  if (attention.length === 0) lines.push("None.");
  for (const a of attention) {
    const gaps = agentGaps(a, planYear);
    lines.push(`- ${a.name} (${a.status}) — score ${a.score.totalScore}/100${gaps.length > 0 ? ` — ${gaps.join("; ")}` : ""}`);
  }
  lines.push("");

  lines.push(`## Licenses expiring within ${EXPIRY_WINDOW_DAYS} days`);
  if (data.expiringLicenses.length === 0) lines.push("None.");
  for (const l of data.expiringLicenses) {
    lines.push(`- ${l.agentName} — ${l.label} — expires ${fmtDate(l.expiryDate)} (${days(now, l.expiryDate)} days)`);
  }
  lines.push("");

  lines.push(`## Carrier certifications expiring within ${EXPIRY_WINDOW_DAYS} days`);
  if (data.expiringCerts.length === 0) lines.push("None.");
  for (const c of data.expiringCerts) {
    lines.push(`- ${c.agentName} — ${c.label} — expires ${fmtDate(c.expiryDate)} (${days(now, c.expiryDate)} days)`);
  }
  lines.push("");

  lines.push("## Agents in good standing");
  lines.push(good.length === 0 ? "None." : good.map((a) => a.name).join(", "));
  lines.push("");
  lines.push("---");
  lines.push(
    "Method: licensing 40 pts (share of licenses active and unexpired), carrier certifications 30 pts " +
      `(share of ${planYear} certifications passed/waived and unexpired), AHIP 20 pts (${planYear} passed/waived), ` +
      "onboarding 10 pts (share of onboarding checklist complete). Terminated and suspended agents are excluded.",
  );
  return lines.join("\n");
}

async function collectReportData(orgId: string, now: Date): Promise<WeeklyReportData | null> {
  const agents = await db
    .select({
      id: agentsTable.id,
      firstName: agentsTable.firstName,
      lastName: agentsTable.lastName,
      status: agentsTable.status,
      npn: agentsTable.npn,
    })
    .from(agentsTable)
    .where(and(eq(agentsTable.orgId, orgId), inArray(agentsTable.status, ["onboarding", "active"])));

  if (agents.length === 0) return null;

  const agentIds = agents.map((a) => a.id);
  const inWindow = new Date(now.getTime() + EXPIRY_WINDOW_DAYS * 86_400_000);
  const nameById = new Map(agents.map((a) => [a.id, `${a.firstName} ${a.lastName}`]));

  const scores = await getAgentComplianceScores({ orgId, agentIds, now });
  const planYear = scores[0]?.planYear;
  if (planYear === undefined) return null;

  const [overdueTasks, licenses, certs, complaintRows, findings] = await Promise.all([
    db
      .select({ agentId: taskInstancesTable.agentId, count: sql<number>`count(*)` })
      .from(taskInstancesTable)
      .where(
        and(
          eq(taskInstancesTable.orgId, orgId),
          inArray(taskInstancesTable.agentId, agentIds),
          inArray(taskInstancesTable.status, ["open", "in_progress"]),
          lt(taskInstancesTable.dueDate, now),
        ),
      )
      .groupBy(taskInstancesTable.agentId),
    db
      .select({
        agentId: stateLicensesTable.agentId,
        stateCode: stateLicensesTable.stateCode,
        licenseType: stateLicensesTable.licenseType,
        expiryDate: stateLicensesTable.expiryDate,
      })
      .from(stateLicensesTable)
      .where(
        and(
          inArray(stateLicensesTable.agentId, agentIds),
          eq(stateLicensesTable.status, "active"),
          gt(stateLicensesTable.expiryDate, now),
          lte(stateLicensesTable.expiryDate, inWindow),
        ),
      )
      .orderBy(stateLicensesTable.expiryDate),
    db
      .select({
        agentId: carrierCertificationsTable.agentId,
        carrierName: carriersTable.name,
        year: carrierCertificationsTable.certificationYear,
        expiryDate: carrierCertificationsTable.expiryDate,
      })
      .from(carrierCertificationsTable)
      .innerJoin(carriersTable, eq(carrierCertificationsTable.carrierId, carriersTable.id))
      .where(
        and(
          inArray(carrierCertificationsTable.agentId, agentIds),
          inArray(carrierCertificationsTable.status, ["passed", "waived"]),
          gt(carrierCertificationsTable.expiryDate, now),
          lte(carrierCertificationsTable.expiryDate, inWindow),
        ),
      )
      .orderBy(carrierCertificationsTable.expiryDate),
    db
      .select({ severity: complaintsTable.severity, dueAt: complaintsTable.dueAt })
      .from(complaintsTable)
      .where(
        and(
          eq(complaintsTable.orgId, orgId),
          notInArray(complaintsTable.status, ["resolved", "closed"]),
        ),
      ),
    // Oversight tasks raised from dialer compliance events carry a
    // `dialer-compliance:` dedup key (lib/dialer/oversight.ts).
    db
      .select({ count: sql<number>`count(*)` })
      .from(taskInstancesTable)
      .where(
        and(
          eq(taskInstancesTable.orgId, orgId),
          isNotNull(taskInstancesTable.retentionReviewKey),
          like(taskInstancesTable.retentionReviewKey, "dialer-compliance:%"),
          inArray(taskInstancesTable.status, ["open", "in_progress"]),
        ),
      ),
  ]);

  const overdueByAgent = new Map(overdueTasks.map((t) => [t.agentId, Number(t.count)]));
  const scoreByAgent = new Map(scores.map((s) => [s.agentId, s]));

  return {
    reportDate: now.toISOString().slice(0, 10),
    now,
    planYear,
    agents: agents
      .filter((a) => scoreByAgent.has(a.id))
      .map((a) => ({
        name: `${a.firstName} ${a.lastName}`,
        status: a.status,
        npn: a.npn,
        score: scoreByAgent.get(a.id)!,
        overdueTasks: overdueByAgent.get(a.id) ?? 0,
      })),
    expiringLicenses: licenses.map((l) => ({
      agentName: nameById.get(l.agentId) ?? "Unknown agent",
      label: `${l.stateCode} ${l.licenseType}`,
      expiryDate: l.expiryDate!,
    })),
    expiringCerts: certs.map((c) => ({
      agentName: nameById.get(c.agentId) ?? "Unknown agent",
      label: `${c.carrierName} (${c.year})`,
      expiryDate: c.expiryDate!,
    })),
    complaints: {
      open: complaintRows.length,
      overdue: complaintRows.filter((c) => c.dueAt && c.dueAt < now).length,
      critical: complaintRows.filter((c) => c.severity === "critical").length,
    },
    openCallComplianceFindings: Number(findings[0]?.count ?? 0),
  };
}

/** Optional advisory commentary. Returns null on any failure. */
async function generateAdvisoryCommentary(orgId: string, reportBody: string): Promise<string | null> {
  const aiClient = getAiClient();
  if (!aiClient) return null;
  try {
    let text = "";
    const stream = await aiClient.chat.completions.create({
      model: resolveAiModel(),
      max_completion_tokens: 1200,
      stream: true,
      messages: [
        {
          role: "user",
          content: [
            "You are assisting the compliance manager of a Medicare insurance agency.",
            "Below is this week's computed compliance report. Do NOT restate, recompute or alter any figure.",
            "Write at most 5 short bullet points ('- ' prefix, plain text, no headings, no tables) naming the",
            "most important actions this week, ordered by regulatory risk. Refer only to facts in the report.",
            "",
            reportBody,
          ].join("\n"),
        },
      ],
    });
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) text += content;
    }
    return text.trim() || null;
  } catch (err) {
    logger.warn({ err, orgId }, "Weekly compliance report: advisory commentary failed (report still produced)");
    return null;
  }
}

async function generateReportForOrg(orgId: string): Promise<void> {
  const now = new Date();
  const data = await collectReportData(orgId, now);
  if (!data) return;

  let report = buildWeeklyComplianceMarkdown(data);
  const commentary = await generateAdvisoryCommentary(orgId, report);
  if (commentary) {
    report += `\n\n## Advisory commentary (AI-generated — not part of the computed report)\n${commentary}`;
  }

  const pdfBuffer = await buildComplianceReportPdf(report, "Weekly Compliance Report", data.reportDate);

  const filename = `weekly-compliance-report-${data.reportDate}.pdf`;
  const storageKey = await storageService.uploadDocument(pdfBuffer, filename, orgId, {
    contentType: "application/pdf",
  });

  const docId = randomUUID();
  await db.insert(documentsTable).values({
    id: docId,
    orgId,
    name: `Weekly Compliance Report — ${data.reportDate}`,
    category: "compliance_report",
    storageKey,
    fileSizeBytes: pdfBuffer.byteLength,
    mimeType: "application/pdf",
    uploadedBy: "system",
  });

  const recipients = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(
      and(
        eq(usersTable.orgId, orgId),
        inArray(usersTable.role, ["super_admin", "agency_admin", "compliance_manager"]),
        eq(usersTable.isActive, true),
      ),
    );

  if (recipients.length > 0) {
    await db.insert(notificationsTable).values(
      recipients.map((user) => ({
        id: randomUUID(),
        orgId,
        userId: user.id,
        type: "compliance",
        title: "Weekly Compliance Report Ready",
        body: `The weekly compliance report for ${data.reportDate} has been generated and saved to your Document Library.`,
        priority: "normal",
        resourceType: "document",
        resourceId: docId,
      })),
    );
  }

  logger.info({ orgId, docId, agentCount: data.agents.length }, "Weekly compliance report generated");
}

export async function weeklyComplianceReportWorker(): Promise<void> {
  const orgs = await db.select({ id: organizationsTable.id }).from(organizationsTable);

  logger.info({ orgCount: orgs.length }, "Weekly compliance report generation started");

  let generated = 0;
  for (const org of orgs) {
    try {
      await generateReportForOrg(org.id);
      generated++;
    } catch (err) {
      logger.error({ err, orgId: org.id }, "Weekly compliance report failed for org — skipping");
    }
  }

  logger.info({ generated }, "Weekly compliance report generation complete");
}
