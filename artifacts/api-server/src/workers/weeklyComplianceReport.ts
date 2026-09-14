/**
 * Weekly Compliance Report Worker.
 *
 * Runs every Monday at 06:00 UTC. For each active organization, generates
 * an AI-powered compliance intelligence report and:
 *  1. Persists the Markdown report to object storage.
 *  2. Inserts a documentsTable record so it appears in the Document Library.
 *  3. Notifies all agency_admin / compliance_manager users in the org.
 *
 * The report is generated via the same prompt used in POST /ai/compliance-report.
 */

import { desc, eq, inArray, and, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  db,
  organizationsTable,
  agentsTable,
  stateLicensesTable,
  carrierCertificationsTable,
  ahipRecordsTable,
  taskInstancesTable,
  documentsTable,
  notificationsTable,
  usersTable,
} from "@workspace/db";
import OpenAI, { AzureOpenAI } from "openai";
import {
  resolveAiProvider,
  resolveAiModel,
  resolveAiBaseUrl,
  resolveAiApiKey,
} from "../lib/aiProvider";

// Provider dispatch — `azure` is the HIPAA-eligible (BAA-covered) path.
// This worker drafts compliance reports from agent PHI, so it MUST go
// through the same guarded provider selection as `routes/ai.ts`.
// `resolveAiProvider()` hard-fails in production unless the provider is
// `azure` — see `lib/aiProvider.ts`.
let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI | null {
  if (_openai) return _openai;
  // resolveAiProvider() is INSIDE the try. The authoritative fail-fast for a
  // non-BAA provider is assertAiProviderHipaaCompliant() at bootstrap
  // (index.ts) -- the process refuses to start, so no request is ever served
  // by a misconfigured deploy. Re-throwing here adds nothing and costs the
  // caller's graceful-degradation contract (the transcript webhook must not
  // 5xx; a worker must not die). Belt-and-braces: return null and let the
  // boot guard be the thing that fails loudly.
  try {
    const provider = resolveAiProvider();
    const apiKey = resolveAiApiKey(provider);
    if (!apiKey) return null;
    if (provider === "azure") {
      const resource = process.env.AI_INTEGRATIONS_AZURE_RESOURCE;
      const endpoint =
        process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ??
        (resource ? `https://${resource}.openai.azure.com` : undefined);
      if (!endpoint) return null;
      const apiVersion =
        process.env.AI_INTEGRATIONS_AZURE_API_VERSION ?? "2024-02-15-preview";
      const deployment = process.env.AI_INTEGRATIONS_AZURE_DEPLOYMENT;
      _openai = new AzureOpenAI({ apiKey, endpoint, apiVersion, deployment });
      return _openai;
    }
    const baseURL = resolveAiBaseUrl(provider);
    if (!baseURL) return null;
    _openai = new OpenAI({ apiKey, baseURL });
    return _openai;
  } catch {
    return null;
  }
}
import { ObjectStorageService } from "../lib/objectStorage";
import { buildComplianceReportPdf } from "../lib/complianceReportPdf";
import { logger } from "../lib/logger";

const storageService = new ObjectStorageService();

async function generateReportForOrg(orgId: string): Promise<void> {
  const now = new Date();
  const in90 = new Date(now.getTime() + 90 * 86_400_000);
  const dateStr = now.toISOString().slice(0, 10);

  const agents = await db
    .select({
      id: agentsTable.id,
      firstName: agentsTable.firstName,
      lastName: agentsTable.lastName,
      status: agentsTable.status,
      npn: agentsTable.npn,
    })
    .from(agentsTable)
    .where(eq(agentsTable.orgId, orgId))
    .limit(100);

  if (agents.length === 0) return;

  const agentDataLines: string[] = [];
  for (const agent of agents) {
    const [licenses, certs, ahip, overdueTasks] = await Promise.all([
      db.select().from(stateLicensesTable).where(eq(stateLicensesTable.agentId, agent.id)).limit(20),
      db.select().from(carrierCertificationsTable).where(eq(carrierCertificationsTable.agentId, agent.id)).limit(20),
      db.select().from(ahipRecordsTable).where(eq(ahipRecordsTable.agentId, agent.id)).orderBy(desc(ahipRecordsTable.certificationYear)).limit(1),
      db.select({ count: sql<number>`count(*)` }).from(taskInstancesTable).where(and(eq(taskInstancesTable.agentId, agent.id), eq(taskInstancesTable.status, "open"))),
    ]);

    const expLicenses = licenses.filter((l) => l.expiryDate && new Date(l.expiryDate) <= in90);
    const expCerts = certs.filter((c) => c.status !== "passed" && c.certificationYear < now.getFullYear());
    const ahipStatus = ahip[0]?.status ?? "none";
    const overdueCount = Number(overdueTasks[0]?.count ?? 0);

    agentDataLines.push(
      `Agent: ${agent.firstName} ${agent.lastName} (${agent.status}) — NPN: ${agent.npn ?? "missing"} — Licenses expiring: ${expLicenses.length} — Certs expiring: ${expCerts.length} — AHIP: ${ahipStatus} — Overdue tasks: ${overdueCount}`,
    );
  }

  const reportPrompt = [
    `You are generating a Weekly Compliance Intelligence Report for a Medicare insurance agency.`,
    `Report date: ${dateStr}`,
    ``,
    `Below is a summary of all agents and their current compliance status. Analyze this data and produce:`,
    `1. An executive summary (2-3 sentences)`,
    `2. Top 5 priority compliance issues ranked by urgency`,
    `3. A ranked table of agents with the most critical compliance gaps`,
    `4. Recommended immediate action items for the compliance manager`,
    `5. Agents in good standing (brief mention)`,
    ``,
    `Format the report as Markdown with clear headers (##) and bullet points.`,
    ``,
    `AGENT COMPLIANCE DATA (${agents.length} agents):`,
    ...agentDataLines,
  ].join("\n");

  const aiClient = getOpenAI();
  if (!aiClient) {
    logger.warn({ orgId }, "Weekly compliance report skipped — AI integration not configured");
    return;
  }

  let fullReport = "";
  try {
    const stream = await aiClient.chat.completions.create({
      model: resolveAiModel(),
      max_completion_tokens: 8192,
      messages: [{ role: "user", content: reportPrompt }],
      stream: true,
    });
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) fullReport += content;
    }
  } catch (err) {
    logger.error({ err, orgId }, "Weekly compliance report AI generation failed");
    return;
  }

  if (!fullReport) return;

  // Generate PDF from the markdown report content
  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await buildComplianceReportPdf(
      fullReport,
      "Weekly Compliance Intelligence Report",
      dateStr,
    );
  } catch (err) {
    logger.error({ err, orgId }, "Failed to generate compliance report PDF");
    return;
  }

  const filename = `weekly-compliance-report-${dateStr}.pdf`;
  let storageKey: string;
  try {
    storageKey = await storageService.uploadDocument(pdfBuffer, filename, orgId, {
      contentType: "application/pdf",
    });
  } catch (err) {
    logger.error({ err, orgId }, "Failed to upload weekly compliance report PDF");
    return;
  }

  const docId = randomUUID();
  await db.insert(documentsTable).values({
    id: docId,
    orgId,
    name: `Weekly Compliance Report — ${dateStr}`,
    category: "compliance_report",
    storageKey,
    fileSizeBytes: pdfBuffer.byteLength,
    mimeType: "application/pdf",
    uploadedBy: "system",
  });

  // Notify all compliance managers and agency admins in the org
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

  for (const user of recipients) {
    await db.insert(notificationsTable).values({
      id: randomUUID(),
      orgId,
      userId: user.id,
      type: "compliance",
      title: "Weekly Compliance Report Ready",
      body: `The weekly compliance intelligence report for ${dateStr} has been generated and saved to your Document Library.`,
      priority: "normal",
      resourceType: "document",
      resourceId: docId,
    });
  }

  logger.info({ orgId, docId, agentCount: agents.length }, "Weekly compliance report generated");
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
