/**
 * AI assistant routes — context-aware LLM chat, outreach drafting,
 * and compliance intelligence reports.
 *
 * POST /ai/chat            — SSE streaming context-aware chat
 * POST /ai/draft           — draft SMS/email text for a contact
 * POST /ai/compliance-report  — SSE streaming agency compliance report
 */

import { Router, type IRouter, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { eq, and, desc, sql, ilike } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  db,
  agentsTable,
  stateLicensesTable,
  carrierCertificationsTable,
  ahipRecordsTable,
  taskInstancesTable,
  contactsTable,
  documentsTable,
} from "@workspace/db";
import { resolveAiModel } from "../lib/aiProvider";
import { buildAiClient } from "../lib/ai/buildAiClient";
import type { ChatCompletionClient } from "../lib/ai/bedrockAnthropicClient";

// Provider dispatch lives in `lib/ai/buildAiClient.ts` — one construction
// site for every AI path, gated by `resolveAiProvider()`. On bedrock the
// returned client is the Anthropic Messages adapter wearing this same shape.
let _aiClient: ChatCompletionClient | null = null;
export function getOpenAI(): ChatCompletionClient | null {
  if (_aiClient) return _aiClient;
  _aiClient = buildAiClient();
  return _aiClient;
}

/** Test-only — reset the memoized client between tests. */
export function _resetOpenAIClient(): void {
  _aiClient = null;
}
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import {
  buildAgentContext,
  buildContactContext,
  buildDashboardContext,
} from "../lib/aiContext";
import { ObjectStorageService } from "../lib/objectStorage";
import { buildComplianceReportPdf } from "../lib/complianceReportPdf";
import { logger } from "../lib/logger";

const storageService = new ObjectStorageService();

const router: IRouter = Router();

/**
 * Strip characters that could be used to inject into the system prompt
 * (newlines, quotes, backslashes) and clamp length. Use whenever a
 * user-controllable DB field (contact / agent name) is interpolated
 * into a prompt template.
 */
function sanitizeForPrompt(s: string): string {
  return s.replace(/[\n\r"\\]/g, "").slice(0, 200);
}

// ---- Per-endpoint AI rate limits (keyed by userId, not IP) ----
//
// Applied AFTER requireAuth so unauthenticated callers hit the auth wall
// first and don't burn rate-limit budget. The limiter only counts the
// initial request; SSE streams don't re-trigger it once the connection
// is open, so streaming behavior is preserved.
const RATE_LIMIT_WINDOW_MS = 60_000;

function aiRateLimiter(max: number) {
  return rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { keyGeneratorIpFallback: false },
    keyGenerator: (req) => (req as AuthenticatedRequest).userId ?? req.ip ?? "unknown",
    message: { error: "AI request rate limit exceeded. Please slow down." },
  });
}

const aiChatLimiter = aiRateLimiter(30);
const aiDraftLimiter = aiRateLimiter(20);
const aiComplianceReportLimiter = aiRateLimiter(5);
const aiComplianceReportDownloadLimiter = aiRateLimiter(30);

const MEDIFLOW_SYSTEM_PREAMBLE = `You are MediFlow AI, an intelligent assistant built into the MediFlow Medicare Sales Agency Platform. You help insurance agents, compliance managers, and agency administrators manage agent lifecycle, CRM contacts, compliance, and outreach.

You have access to real-time platform data provided in the context below. Always base your answers on this data — never fabricate names, numbers, or details. When asked to draft communications, produce professional, compliant content appropriate for Medicare insurance outreach.

Available slash commands:
  /compliance-check [agent name] — structured compliance gap report with prioritized action items
  /draft-sms [contact name] [goal] — SMS draft using contact's Medicare context
  /draft-email [contact name] [goal] — full email draft
  /summarize [contact name] — brief on contact history + recommended next action
  /renewal-report — agency-wide license/cert renewal status narrative
  /offboarding-check [agent name] — list all remaining offboarding steps

Always be concise, accurate, and action-oriented. Format reports and gap analyses as structured Markdown with headers and bullet points.`;

// ---- POST /ai/chat ----

const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

const ChatRequestSchema = z.object({
  message: z.string().min(1).max(8000),
  history: z.array(ChatMessageSchema).max(50).optional().default([]),
  context: z.object({
    pageType: z.enum(["dashboard", "agent", "contact", "other"]).optional(),
    agentId: z.string().optional(),
    contactId: z.string().optional(),
  }).optional(),
});

router.post(
  "/ai/chat",
  requireAuth,
  aiChatLimiter,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    const { message, history, context } = parsed.data;

    // Build page-specific context
    let pageContext = "";
    try {
      if (context?.pageType === "agent" && context.agentId) {
        pageContext = await buildAgentContext(context.agentId, authReq.orgId);
      } else if (context?.pageType === "contact" && context.contactId) {
        pageContext = await buildContactContext(context.contactId, authReq.orgId);
      } else if (context?.pageType === "dashboard") {
        pageContext = await buildDashboardContext(authReq.orgId);
      }
    } catch (err) {
      logger.warn({ err }, "Failed to build AI page context — proceeding without it");
    }

    const systemPrompt = [
      MEDIFLOW_SYSTEM_PREAMBLE,
      `\nUser role: ${authReq.userRole}`,
      `Organization ID: ${authReq.orgId}`,
      pageContext ? `\n--- CURRENT PAGE CONTEXT ---\n${pageContext}\n--- END CONTEXT ---` : "",
    ].filter(Boolean).join("\n");

    // Parse slash commands to structured prompts with entity resolution
    const processedMessage = await resolveSlashCommand(message, authReq.orgId);

    const chatMessages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "system", content: systemPrompt },
      ...history.map((h) => ({ role: h.role as "user" | "assistant", content: h.content })),
      { role: "user", content: processedMessage },
    ];

    const aiClient = getOpenAI();
    if (!aiClient) {
      res.status(503).json({ error: "AI integration is not configured" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    // Stop generating when the browser goes away. `res.write()` on a dead
    // socket returns false without throwing, so without this the loop runs to
    // natural completion -- up to max_completion_tokens of Bedrock output that
    // is billed and thrown away, with the connection slot held for the whole
    // generation. Reported by the AWS review agent on PR #207.
    //
    // `close` also fires on a normal end, after the loop is done; aborting a
    // finished stream is a no-op, so there is no truncation risk here.
    const controller = new AbortController();
    let clientGone = false;
    res.on("close", () => {
      clientGone = true;
      controller.abort();
    });

    try {
      const stream = await aiClient.chat.completions.create(
        {
          model: resolveAiModel(),
          max_completion_tokens: 8192,
          messages: chatMessages,
          stream: true,
        },
        { signal: controller.signal },
      );

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content;
        if (content) {
          res.write(`data: ${JSON.stringify({ content })}\n\n`);
        }
      }

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    } catch (err) {
      // An abort we caused is not a failure -- and there is nobody left to
      // read the error frame anyway.
      if (clientGone) {
        logger.info("AI chat stream aborted: client disconnected");
      } else {
        logger.error({ err }, "AI chat stream failed");
        res.write(
          `data: ${JSON.stringify({ error: "AI service unavailable" })}\n\n`,
        );
      }
    } finally {
      res.end();
    }
  },
);

// ---- POST /ai/draft ----

const DraftRequestSchema = z.object({
  channel: z.enum(["sms", "email"]),
  contactId: z.string(),
  goal: z.string().min(1).max(500),
});

router.post(
  "/ai/draft",
  requireAuth,
  aiDraftLimiter,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = DraftRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    const { channel, contactId, goal } = parsed.data;

    const [contact] = await db
      .select()
      .from(contactsTable)
      .where(and(eq(contactsTable.id, contactId), eq(contactsTable.orgId, authReq.orgId)))
      .limit(1);

    if (!contact) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }

    const contactCtx = await buildContactContext(contactId, authReq.orgId);

    const channelInstructions =
      channel === "sms"
        ? "Draft a concise, professional SMS message (max 160 characters). No subject line. Return ONLY the message text."
        : "Draft a professional email with a subject line and body. Return JSON with keys 'subject' (string) and 'body' (string). The body should use plain text with paragraphs.";

    const prompt = [
      `You are drafting outreach for a Medicare insurance agent.`,
      `Channel: ${channel.toUpperCase()}`,
      `Goal: ${goal}`,
      ``,
      contactCtx,
      ``,
      channelInstructions,
    ].join("\n");

    const aiClient = getOpenAI();
    if (!aiClient) {
      res.status(503).json({ error: "AI integration is not configured" });
      return;
    }

    try {
      const response = await aiClient.chat.completions.create({
        model: resolveAiModel(),
        max_completion_tokens: channel === "sms" ? 256 : 1024,
        messages: [{ role: "user", content: prompt }],
        stream: false,
      });

      const text = response.choices[0]?.message?.content ?? "";

      if (channel === "email") {
        try {
          const parsed = JSON.parse(text) as { subject?: string; body?: string };
          res.json({ draft: parsed.body ?? text, subject: parsed.subject ?? "", aiAssisted: true });
          return;
        } catch {
          res.json({ draft: text, subject: "", aiAssisted: true });
          return;
        }
      }

      res.json({ draft: text, aiAssisted: true });
    } catch (err) {
      logger.error({ err }, "AI draft failed");
      res.status(503).json({ error: "AI service unavailable" });
    }
  },
);

// ---- POST /ai/compliance-report ----

router.post(
  "/ai/compliance-report",
  requireAuth,
  aiComplianceReportLimiter,
  requirePermission("compliance_report", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    const now = new Date();
    const in90 = new Date(now.getTime() + 90 * 86400000);

    // Fetch all agents and their compliance data
    let agents: {
      id: string; firstName: string; lastName: string; email: string; status: string; npn: string | null;
    }[] = [];

    try {
      agents = await db
        .select({ id: agentsTable.id, firstName: agentsTable.firstName, lastName: agentsTable.lastName, email: agentsTable.email, status: agentsTable.status, npn: agentsTable.npn })
        .from(agentsTable)
        .where(eq(agentsTable.orgId, authReq.orgId))
        .limit(100);
    } catch (err) {
      logger.error({ err }, "Failed to fetch agents for compliance report");
      res.status(500).json({ error: "Failed to fetch agent data" });
      return;
    }

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
      `You are generating a Compliance Intelligence Report for a Medicare insurance agency.`,
      `Today's date: ${now.toISOString().slice(0, 10)}`,
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
      res.status(503).json({ error: "AI integration is not configured" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    // NO AbortController here, deliberately -- unlike /ai/chat above.
    //
    // This route's real output is the PDF persisted below, not the stream; the
    // stream is just progress. Cancelling on client disconnect would leave
    // `fullReport` truncated and then persist THAT as a compliance document,
    // which is worse than the wasted tokens it saves: a partial compliance
    // report in object storage looks complete to whoever opens it next.
    // Letting the generation finish costs tokens and produces a correct
    // artifact the operator can still retrieve.
    try {
      const stream = await aiClient.chat.completions.create({
        model: resolveAiModel(),
        max_completion_tokens: 8192,
        messages: [{ role: "user", content: reportPrompt }],
        stream: true,
      });

      let fullReport = "";
      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content;
        if (content) {
          fullReport += content;
          res.write(`data: ${JSON.stringify({ content })}\n\n`);
        }
      }

      // Persist the full report as PDF to object storage + documents table
      let documentId: string | null = null;
      if (fullReport.length > 0) {
        try {
          const dateStr = now.toISOString().slice(0, 10);
          const pdfBuffer = await buildComplianceReportPdf(
            fullReport,
            "AI Compliance Intelligence Report",
            dateStr,
          );
          const filename = `compliance-report-${dateStr}.pdf`;
          const storageKey = await storageService.uploadDocument(
            pdfBuffer,
            filename,
            authReq.orgId,
            { contentType: "application/pdf" },
          );
          const docId = randomUUID();
          await db.insert(documentsTable).values({
            id: docId,
            orgId: authReq.orgId,
            name: `AI Compliance Report — ${dateStr}`,
            category: "compliance_report",
            storageKey,
            fileSizeBytes: pdfBuffer.byteLength,
            mimeType: "application/pdf",
            uploadedBy: authReq.userId,
          });
          documentId = docId;
        } catch (persistErr) {
          logger.warn({ persistErr }, "Failed to persist compliance report PDF — streaming result still delivered");
        }
      }

      res.write(`data: ${JSON.stringify({ done: true, reportLength: fullReport.length, documentId })}\n\n`);
    } catch (err) {
      logger.error({ err }, "AI compliance report stream failed");
      res.write(`data: ${JSON.stringify({ error: "AI service unavailable" })}\n\n`);
    } finally {
      res.end();
    }
  },
);

// ---- GET /ai/compliance-report/:documentId — download stored report ----

router.get(
  "/ai/compliance-report/:documentId",
  requireAuth,
  aiComplianceReportDownloadLimiter,
  requirePermission("compliance_report", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const documentId = Array.isArray(req.params.documentId)
      ? req.params.documentId[0]
      : req.params.documentId;

    const [doc] = await db
      .select()
      .from(documentsTable)
      .where(
        and(
          eq(documentsTable.id, documentId),
          eq(documentsTable.orgId, authReq.orgId),
        ),
      )
      .limit(1);

    if (!doc) {
      res.status(404).json({ error: "Compliance report not found" });
      return;
    }

    try {
      const signedUrl = await storageService.getDocumentSignedUrl(doc.storageKey, 900);
      // Redirect to a time-limited signed URL so the client can download
      res.redirect(302, signedUrl);
    } catch (err) {
      logger.error({ err, documentId }, "Failed to retrieve compliance report from storage");
      res.status(500).json({ error: "Failed to retrieve report" });
    }
  },
);

// ---- Slash command resolver (async — resolves named entities from DB) ----

async function resolveSlashCommand(message: string, orgId: string): Promise<string> {
  const trimmed = message.trim();

  const complianceMatch = trimmed.match(/^\/compliance-check\s+(.+)/i);
  if (complianceMatch) {
    const name = complianceMatch[1].trim();
    const safeName = sanitizeForPrompt(name);
    const nameParts = name.split(/\s+/);
    const agents = await db.select().from(agentsTable).where(
      and(
        eq(agentsTable.orgId, orgId),
        nameParts.length > 1
          ? and(ilike(agentsTable.firstName, `%${nameParts[0]}%`), ilike(agentsTable.lastName, `%${nameParts[nameParts.length - 1]}%`))
          : ilike(agentsTable.firstName, `%${name}%`),
      ),
    ).limit(1);
    if (agents[0]) {
      const ctx = await buildAgentContext(agents[0].id, orgId);
      const safeFirst = sanitizeForPrompt(agents[0].firstName);
      const safeLast = sanitizeForPrompt(agents[0].lastName);
      return `Perform a full compliance gap report for ${safeFirst} ${safeLast}. Include: (1) License status and expiry risks, (2) Carrier certification gaps, (3) AHIP status, (4) Overdue tasks, (5) Priority action items ranked by urgency. Format as structured Markdown.\n\nAGENT DATA:\n${ctx}`;
    }
    return `Perform a full compliance gap report for the agent named "${safeName}". No matching agent was found in the system — ask the user to verify the name. Include: (1) License status and expiry risks, (2) Carrier certification gaps, (3) AHIP status, (4) Overdue tasks, (5) Priority action items ranked by urgency. Format as structured Markdown.`;
  }

  const draftSmsMatch = trimmed.match(/^\/draft-sms\s+(\S+(?:\s+\S+)?)\s+(.+)/i);
  if (draftSmsMatch) {
    const contactName = draftSmsMatch[1].trim();
    const goal = draftSmsMatch[2].trim();
    const safeName = sanitizeForPrompt(contactName);
    const safeGoal = sanitizeForPrompt(goal);
    const nameParts = contactName.split(/\s+/);
    const contacts = await db.select().from(contactsTable).where(
      and(
        eq(contactsTable.orgId, orgId),
        nameParts.length > 1
          ? and(ilike(contactsTable.firstName, `%${nameParts[0]}%`), ilike(contactsTable.lastName, `%${nameParts[nameParts.length - 1]}%`))
          : ilike(contactsTable.firstName, `%${contactName}%`),
      ),
    ).limit(1);
    if (contacts[0]) {
      const ctx = await buildContactContext(contacts[0].id, orgId);
      const safeFirst = sanitizeForPrompt(contacts[0].firstName);
      const safeLast = sanitizeForPrompt(contacts[0].lastName);
      return `Draft a professional SMS (max 160 chars) for ${safeFirst} ${safeLast}. Goal: ${safeGoal}. Return ONLY the message text.\n\nCONTACT DATA:\n${ctx}`;
    }
    return `Draft a professional SMS (max 160 chars) for the contact named "${safeName}". Goal: ${safeGoal}. Return ONLY the message text. Note: no matching contact found — draft a generic outreach.`;
  }

  const draftEmailMatch = trimmed.match(/^\/draft-email\s+(\S+(?:\s+\S+)?)\s+(.+)/i);
  if (draftEmailMatch) {
    const contactName = draftEmailMatch[1].trim();
    const goal = draftEmailMatch[2].trim();
    const safeName = sanitizeForPrompt(contactName);
    const safeGoal = sanitizeForPrompt(goal);
    const nameParts = contactName.split(/\s+/);
    const contacts = await db.select().from(contactsTable).where(
      and(
        eq(contactsTable.orgId, orgId),
        nameParts.length > 1
          ? and(ilike(contactsTable.firstName, `%${nameParts[0]}%`), ilike(contactsTable.lastName, `%${nameParts[nameParts.length - 1]}%`))
          : ilike(contactsTable.firstName, `%${contactName}%`),
      ),
    ).limit(1);
    if (contacts[0]) {
      const ctx = await buildContactContext(contacts[0].id, orgId);
      const safeFirst = sanitizeForPrompt(contacts[0].firstName);
      const safeLast = sanitizeForPrompt(contacts[0].lastName);
      return `Draft a professional email for ${safeFirst} ${safeLast}. Goal: ${safeGoal}. Return JSON with keys "subject" (string) and "body" (plain text with paragraphs).\n\nCONTACT DATA:\n${ctx}`;
    }
    return `Draft a professional email for the contact named "${safeName}". Goal: ${safeGoal}. Return JSON with keys "subject" (string) and "body" (plain text with paragraphs). Note: no matching contact found — draft generic outreach.`;
  }

  const summarizeMatch = trimmed.match(/^\/summarize\s+(.+)/i);
  if (summarizeMatch) {
    const name = summarizeMatch[1].trim();
    const safeName = sanitizeForPrompt(name);
    const nameParts = name.split(/\s+/);
    const contacts = await db.select().from(contactsTable).where(
      and(
        eq(contactsTable.orgId, orgId),
        nameParts.length > 1
          ? and(ilike(contactsTable.firstName, `%${nameParts[0]}%`), ilike(contactsTable.lastName, `%${nameParts[nameParts.length - 1]}%`))
          : ilike(contactsTable.firstName, `%${name}%`),
      ),
    ).limit(1);
    if (contacts[0]) {
      const ctx = await buildContactContext(contacts[0].id, orgId);
      const safeFirst = sanitizeForPrompt(contacts[0].firstName);
      const safeLast = sanitizeForPrompt(contacts[0].lastName);
      return `Provide a brief summary for ${safeFirst} ${safeLast}: (1) enrollment status overview, (2) last interaction and outcome, (3) current sequence status, (4) recommended next action. Be concise (under 200 words).\n\nCONTACT DATA:\n${ctx}`;
    }
    return `Provide a brief summary for the contact named "${safeName}": (1) enrollment status overview, (2) last interaction and outcome, (3) current sequence status, (4) recommended next action. Be concise (under 200 words). Note: no matching contact found.`;
  }

  const renewalMatch = trimmed.match(/^\/renewal-report/i);
  if (renewalMatch) {
    return `Generate a concise agency-wide license and certification renewal status narrative. Identify: (1) who needs to renew within 30 days, (2) who needs to renew within 60-90 days, (3) any missing or lapsed credentials. Rank by urgency and provide a prioritized action list for the compliance manager.`;
  }

  const offboardingMatch = trimmed.match(/^\/offboarding-check\s+(.+)/i);
  if (offboardingMatch) {
    const name = offboardingMatch[1].trim();
    const safeName = sanitizeForPrompt(name);
    const nameParts = name.split(/\s+/);
    const agents = await db.select().from(agentsTable).where(
      and(
        eq(agentsTable.orgId, orgId),
        nameParts.length > 1
          ? and(ilike(agentsTable.firstName, `%${nameParts[0]}%`), ilike(agentsTable.lastName, `%${nameParts[nameParts.length - 1]}%`))
          : ilike(agentsTable.firstName, `%${name}%`),
      ),
    ).limit(1);
    if (agents[0]) {
      const ctx = await buildAgentContext(agents[0].id, orgId);
      const safeFirst = sanitizeForPrompt(agents[0].firstName);
      const safeLast = sanitizeForPrompt(agents[0].lastName);
      return `List all offboarding steps remaining for ${safeFirst} ${safeLast}. Include: (1) open tasks to complete or transfer, (2) active licenses to surrender or transfer, (3) carrier certifications to update, (4) contact reassignments needed, (5) documentation requirements. Format as a checklist.\n\nAGENT DATA:\n${ctx}`;
    }
    return `List all offboarding steps remaining for the agent named "${safeName}". Include: (1) open tasks to complete or transfer, (2) active licenses to surrender or transfer, (3) carrier certifications to update, (4) contact reassignments needed, (5) documentation requirements. Format as a checklist. Note: no matching agent found.`;
  }

  return message;
}

export default router;
