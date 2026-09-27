/**
 * Email client (Resend).
 *
 * Typed, never-throw interface for transactional emails.
 * Required env secret: RESEND_API_KEY
 * Optional env: EMAIL_FROM_ADDRESS (default: noreply@mediflow.app)
 *
 * Includes a complete set of branded HTML templates for all system emails.
 */

import { logger } from "./logger";

export type EmailRecipient = { email: string; name?: string };

/**
 * File attachment for a transactional email. Resend's API accepts the bytes
 * base64-encoded in the JSON payload (no multipart upload step needed).
 *
 * Used by the Day-6 contracting email-out worker to send signed PDFs to
 * carrier appointment desks. We deliberately do NOT log attachment bytes
 * anywhere — the signed PDF contains PII (SSN, DOB, address) and the email
 * body is the only sink that should ever see those bytes.
 */
export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface SendEmailOptions {
  to: EmailRecipient | EmailRecipient[];
  cc?: EmailRecipient | EmailRecipient[];
  subject: string;
  html: string;
  text?: string;
  from?: string;
  replyTo?: string;
  tags?: Record<string, string>;
  /** Extra MIME headers (e.g. List-Unsubscribe on consumer email). */
  headers?: Record<string, string>;
  attachments?: EmailAttachment[];
}

export interface EmailResult {
  id: string;
  success: true;
}

export interface EmailError {
  success: false;
  error: string;
}

const RESEND_API_URL = "https://api.resend.com/emails";
const DEFAULT_FROM = process.env.EMAIL_FROM_ADDRESS ?? "noreply@mediflow.app";

export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

/**
 * Send a transactional email via Resend.
 * Returns a result object — never throws.
 */
export async function sendEmail(
  opts: SendEmailOptions,
): Promise<EmailResult | EmailError> {
  if (!isEmailConfigured()) {
    logger.warn("RESEND_API_KEY not set — email not sent");
    return { success: false, error: "Email not configured" };
  }

  const toArray = Array.isArray(opts.to) ? opts.to : [opts.to];
  const toAddresses = toArray.map((r) =>
    r.name ? `${r.name} <${r.email}>` : r.email,
  );
  const ccArray = opts.cc
    ? Array.isArray(opts.cc)
      ? opts.cc
      : [opts.cc]
    : [];
  const ccAddresses = ccArray.map((r) =>
    r.name ? `${r.name} <${r.email}>` : r.email,
  );

  const payload = {
    from: opts.from ?? DEFAULT_FROM,
    to: toAddresses,
    ...(ccAddresses.length > 0 ? { cc: ccAddresses } : {}),
    subject: opts.subject,
    html: opts.html,
    ...(opts.text ? { text: opts.text } : {}),
    ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
    ...(opts.headers && Object.keys(opts.headers).length > 0 ? { headers: opts.headers } : {}),
    ...(opts.tags
      ? {
          tags: Object.entries(opts.tags).map(([k, v]) => ({
            name: k,
            value: v,
          })),
        }
      : {}),
    // Attachments are base64-encoded inline per the Resend API. We never log
    // the encoded bytes — the surrounding worker scrubs payload from any log
    // line (see `submitContractingPacket.ts`).
    ...(opts.attachments && opts.attachments.length > 0
      ? {
          attachments: opts.attachments.map((a) => ({
            filename: a.filename,
            content: a.content.toString("base64"),
            ...(a.contentType ? { content_type: a.contentType } : {}),
          })),
        }
      : {}),
  };

  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => null) as { message?: string } | null;
      const msg = body?.message ?? `HTTP ${res.status}`;
      logger.error({ subject: opts.subject, status: res.status }, `Email send failed: ${msg}`);
      return { success: false, error: msg };
    }

    const data = await res.json() as { id: string };
    return { id: data.id, success: true };
  } catch (err) {
    logger.error({ err, subject: opts.subject }, "Email send exception");
    return { success: false, error: (err as Error).message };
  }
}

// ============================================================
// HTML Template library — all agency email types
// ============================================================

const BRAND_HEADER = `
<div style="background:#1e3a5f;padding:20px 32px;border-radius:8px 8px 0 0">
  <h1 style="color:#fff;margin:0;font-size:18px;font-weight:700;letter-spacing:-0.3px">agencyBRIDGE</h1>
  <p style="color:#93c5fd;margin:2px 0 0;font-size:12px">Medicare Agency Platform</p>
</div>`.trim();

const BRAND_FOOTER = `
<div style="background:#f8fafc;padding:16px 32px;border-top:1px solid #e2e8f0;border-radius:0 0 8px 8px">
  <p style="color:#94a3b8;font-size:11px;margin:0;line-height:1.5">
    This is an automated message from agencyBRIDGE. Do not reply to this email.
  </p>
</div>`.trim();

/**
 * HTML-escapes an interpolated text value.
 *
 * Organization names and user full names are free text the customer controls,
 * and they land in the body of an email sent to someone who has not joined the
 * agency yet — a recipient with no way to judge whether the message is honest.
 * Unescaped, `name` can carry markup and rewrite what the invitation appears to
 * say, including the link it appears to point at.
 *
 * Escaping `"` and `'` too, so the same helper is safe inside an attribute.
 *
 * NOTE: the templates above this point predate the helper and still interpolate
 * raw. They are addressed to people already inside the agency rather than to
 * outsiders, so the exposure differs — but it is real, and fixing it is out of
 * this change's scope rather than out of the question.
 */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function wrap(body: string): string {
  return `
<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px;background:#f1f5f9;font-family:Inter,system-ui,sans-serif">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #e2e8f0;overflow:hidden">
${BRAND_HEADER}
<div style="padding:28px 32px">
${body}
</div>
${BRAND_FOOTER}
</div>
</body></html>`.trim();
}

// --- Welcome / Onboarding ---

export function welcomeEmailHtml(opts: {
  agentName: string;
  agencyName: string;
  loginUrl: string;
}): string {
  return wrap(`
<h2 style="margin:0 0 8px;font-size:20px;color:#0f172a">Welcome to ${opts.agencyName}!</h2>
<p style="color:#475569;margin:0 0 16px">Hi ${opts.agentName},</p>
<p style="color:#475569;margin:0 0 20px">Your agencyBRIDGE account has been set up. You can now access your agent portal to view your licensing, certifications, and tasks.</p>
<a href="${opts.loginUrl}" style="display:inline-block;background:#1d4ed8;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px">Access Your Portal</a>
<p style="color:#94a3b8;font-size:12px;margin:20px 0 0">If you didn't expect this email, you can safely ignore it.</p>`);
}

// --- License expiry ---

export function licenseExpiryEmailHtml(opts: {
  agentName: string;
  stateCode: string;
  licenseType: string;
  daysUntilExpiry: number;
  expiryDate: string;
}): string {
  const urgency = opts.daysUntilExpiry <= 30 ? "⚠️ URGENT: " : "";
  const badgeColor = opts.daysUntilExpiry <= 14 ? "#dc2626" : opts.daysUntilExpiry <= 30 ? "#d97706" : "#2563eb";
  return wrap(`
<h2 style="margin:0 0 4px;font-size:18px;color:#0f172a">${urgency}License Expiring in ${opts.daysUntilExpiry} Day${opts.daysUntilExpiry !== 1 ? "s" : ""}</h2>
<span style="display:inline-block;background:${badgeColor};color:#fff;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;margin-bottom:16px">${opts.daysUntilExpiry <= 30 ? "Action Required" : "Upcoming"}</span>
<p style="color:#475569;margin:0 0 12px">Hi ${opts.agentName},</p>
<p style="color:#475569;margin:0 0 16px">Your <strong>${opts.stateCode} ${opts.licenseType}</strong> license is expiring on <strong>${opts.expiryDate}</strong>. Please renew it to continue selling Medicare products in ${opts.stateCode}.</p>
<table style="width:100%;border-collapse:collapse;margin:0 0 20px">
  <tr><td style="padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;color:#64748b;font-size:13px;width:40%">State</td><td style="padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;color:#0f172a;font-size:13px">${opts.stateCode}</td></tr>
  <tr><td style="padding:8px 12px;border:1px solid #e2e8f0;color:#64748b;font-size:13px">License Type</td><td style="padding:8px 12px;border:1px solid #e2e8f0;color:#0f172a;font-size:13px">${opts.licenseType}</td></tr>
  <tr><td style="padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;color:#64748b;font-size:13px">Expiry Date</td><td style="padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;color:#0f172a;font-size:13px;font-weight:600">${opts.expiryDate}</td></tr>
</table>`);
}

// --- AHIP reminder ---

export function ahipReminderEmailHtml(opts: {
  agentName: string;
  certificationYear: number;
  deadlineDate?: string;
}): string {
  return wrap(`
<h2 style="margin:0 0 4px;font-size:18px;color:#0f172a">AHIP ${opts.certificationYear} Certification Reminder</h2>
<p style="color:#475569;margin:0 0 12px">Hi ${opts.agentName},</p>
<p style="color:#475569;margin:0 0 16px">Your <strong>AHIP certification for ${opts.certificationYear}</strong> has not been completed. AHIP certification is required to sell Medicare Advantage and Part D plans.</p>
${opts.deadlineDate ? `<p style="color:#dc2626;font-weight:600;margin:0 0 16px">⚠️ Deadline: ${opts.deadlineDate}</p>` : ""}
<p style="color:#475569;margin:0 0 8px">Steps to complete:</p>
<ol style="color:#475569;margin:0 0 16px;padding-left:20px;line-height:1.7">
  <li>Visit <a href="https://ahip.org" style="color:#2563eb">ahip.org</a></li>
  <li>Log in or create your account</li>
  <li>Complete the Medicare training modules</li>
  <li>Pass the certification test (score ≥ 90%)</li>
  <li>Upload your certificate to agencyBRIDGE</li>
</ol>`);
}

// --- Task assigned ---

export function taskAssignedEmailHtml(opts: {
  assigneeName: string;
  taskTitle: string;
  taskDescription?: string;
  dueDate?: string;
  priority: "low" | "medium" | "high" | "urgent";
  portalUrl: string;
}): string {
  const priorityColor = { low: "#64748b", medium: "#2563eb", high: "#d97706", urgent: "#dc2626" };
  const color = priorityColor[opts.priority];
  return wrap(`
<h2 style="margin:0 0 4px;font-size:18px;color:#0f172a">New Task Assigned</h2>
<p style="color:#475569;margin:0 0 12px">Hi ${opts.assigneeName},</p>
<p style="color:#475569;margin:0 0 16px">A new task has been assigned to you:</p>
<div style="border:1px solid #e2e8f0;border-radius:6px;padding:16px;margin-bottom:20px">
  <h3 style="margin:0 0 8px;font-size:15px;color:#0f172a">${opts.taskTitle}</h3>
  ${opts.taskDescription ? `<p style="color:#64748b;font-size:13px;margin:0 0 12px">${opts.taskDescription}</p>` : ""}
  <div style="display:flex;gap:12px;flex-wrap:wrap">
    <span style="color:${color};font-size:12px;font-weight:600;text-transform:uppercase">${opts.priority} priority</span>
    ${opts.dueDate ? `<span style="color:#64748b;font-size:12px">Due: <strong>${opts.dueDate}</strong></span>` : ""}
  </div>
</div>
<a href="${opts.portalUrl}" style="display:inline-block;background:#1d4ed8;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px">View Task</a>`);
}

// --- Offboarding notice ---

export function offboardingNoticeEmailHtml(opts: {
  agentName: string;
  offboardDate: string;
  agencyName: string;
  completedSteps: string[];
  pendingSteps: string[];
}): string {
  return wrap(`
<h2 style="margin:0 0 4px;font-size:18px;color:#0f172a">Agent Offboarding Notice</h2>
<p style="color:#475569;margin:0 0 12px">Hi ${opts.agentName},</p>
<p style="color:#475569;margin:0 0 16px">Your offboarding from <strong>${opts.agencyName}</strong> has been initiated. Your last day is <strong>${opts.offboardDate}</strong>.</p>
${opts.completedSteps.length > 0 ? `
<p style="color:#475569;margin:0 0 8px;font-weight:600">Completed steps:</p>
<ul style="color:#475569;margin:0 0 16px;padding-left:20px;line-height:1.7">
  ${opts.completedSteps.map((s) => `<li style="color:#16a34a">${s}</li>`).join("")}
</ul>` : ""}
${opts.pendingSteps.length > 0 ? `
<p style="color:#dc2626;margin:0 0 8px;font-weight:600">Pending steps:</p>
<ul style="color:#475569;margin:0 0 16px;padding-left:20px;line-height:1.7">
  ${opts.pendingSteps.map((s) => `<li>${s}</li>`).join("")}
</ul>` : ""}
<p style="color:#64748b;font-size:13px;margin:0">Please contact your manager if you have any questions about the offboarding process.</p>`);
}

// --- Carrier cert expiry ---

export function certExpiryEmailHtml(opts: {
  agentName: string;
  carrierName: string;
  certificationYear: number;
  daysUntilExpiry: number;
  expiryDate: string;
}): string {
  const urgency = opts.daysUntilExpiry <= 30 ? "⚠️ URGENT: " : "";
  const badgeColor = opts.daysUntilExpiry <= 14 ? "#dc2626" : opts.daysUntilExpiry <= 30 ? "#d97706" : "#2563eb";
  return wrap(`
<h2 style="margin:0 0 4px;font-size:18px;color:#0f172a">${urgency}Carrier Certification Expiring in ${opts.daysUntilExpiry} Day${opts.daysUntilExpiry !== 1 ? "s" : ""}</h2>
<span style="display:inline-block;background:${badgeColor};color:#fff;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;margin-bottom:16px">${opts.daysUntilExpiry <= 30 ? "Action Required" : "Upcoming"}</span>
<p style="color:#475569;margin:0 0 12px">Hi ${opts.agentName},</p>
<p style="color:#475569;margin:0 0 16px">Your <strong>${opts.carrierName} ${opts.certificationYear}</strong> certification expires on <strong>${opts.expiryDate}</strong>. Please renew your certification to continue selling ${opts.carrierName} Medicare plans.</p>
<table style="width:100%;border-collapse:collapse;margin:0 0 20px">
  <tr><td style="padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;color:#64748b;font-size:13px;width:40%">Carrier</td><td style="padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;color:#0f172a;font-size:13px">${opts.carrierName}</td></tr>
  <tr><td style="padding:8px 12px;border:1px solid #e2e8f0;color:#64748b;font-size:13px">Year</td><td style="padding:8px 12px;border:1px solid #e2e8f0;color:#0f172a;font-size:13px">${opts.certificationYear}</td></tr>
  <tr><td style="padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;color:#64748b;font-size:13px">Expiry Date</td><td style="padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;color:#0f172a;font-size:13px;font-weight:600">${opts.expiryDate}</td></tr>
</table>`);
}

// --- Compliance report ---

export function complianceReportEmailHtml(opts: {
  recipientName: string;
  agencyName: string;
  reportPeriod: string;
  totalAgents: number;
  compliantAgents: number;
  expiredLicenses: number;
  missingAhip: number;
  overdueTasks: number;
}): string {
  const complianceRate = opts.totalAgents > 0
    ? Math.round((opts.compliantAgents / opts.totalAgents) * 100)
    : 0;
  const rateColor = complianceRate >= 90 ? "#16a34a" : complianceRate >= 70 ? "#d97706" : "#dc2626";
  return wrap(`
<h2 style="margin:0 0 4px;font-size:18px;color:#0f172a">Compliance Report — ${opts.reportPeriod}</h2>
<p style="color:#475569;margin:0 0 12px">Hi ${opts.recipientName},</p>
<p style="color:#475569;margin:0 0 16px">Here is the compliance summary for <strong>${opts.agencyName}</strong> for ${opts.reportPeriod}:</p>
<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:16px;margin-bottom:20px">
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
    <span style="font-size:36px;font-weight:700;color:${rateColor}">${complianceRate}%</span>
    <span style="color:#64748b;font-size:13px">overall compliance rate</span>
  </div>
  <table style="width:100%;border-collapse:collapse">
    <tr><td style="padding:6px 0;color:#64748b;font-size:13px">Total Agents</td><td style="padding:6px 0;color:#0f172a;font-size:13px;text-align:right;font-weight:600">${opts.totalAgents}</td></tr>
    <tr><td style="padding:6px 0;color:#64748b;font-size:13px">Fully Compliant</td><td style="padding:6px 0;color:#16a34a;font-size:13px;text-align:right;font-weight:600">${opts.compliantAgents}</td></tr>
    <tr><td style="padding:6px 0;color:#64748b;font-size:13px">Expired Licenses</td><td style="padding:6px 0;color:${opts.expiredLicenses > 0 ? "#dc2626" : "#16a34a"};font-size:13px;text-align:right;font-weight:600">${opts.expiredLicenses}</td></tr>
    <tr><td style="padding:6px 0;color:#64748b;font-size:13px">Missing AHIP</td><td style="padding:6px 0;color:${opts.missingAhip > 0 ? "#d97706" : "#16a34a"};font-size:13px;text-align:right;font-weight:600">${opts.missingAhip}</td></tr>
    <tr><td style="padding:6px 0;color:#64748b;font-size:13px">Overdue Tasks</td><td style="padding:6px 0;color:${opts.overdueTasks > 0 ? "#d97706" : "#16a34a"};font-size:13px;text-align:right;font-weight:600">${opts.overdueTasks}</td></tr>
  </table>
</div>`);
}

// --- Team invitation ---

export function invitationEmailHtml(opts: {
  agencyName: string;
  inviterName: string;
  roleLabel: string;
  acceptUrl: string;
  expiresInDays: number;
}): string {
  const agency = esc(opts.agencyName);
  const inviter = esc(opts.inviterName);
  const role = esc(opts.roleLabel);
  const href = esc(opts.acceptUrl);
  const days = Number(opts.expiresInDays);

  return wrap(`
<h2 style="margin:0 0 8px;font-size:20px;color:#0f172a">You've been invited to ${agency}</h2>
<p style="color:#475569;margin:0 0 16px">${inviter} has invited you to join <strong>${agency}</strong> on agencyBRIDGE as a <strong>${role}</strong>.</p>
<p style="color:#475569;margin:0 0 20px">Accepting adds your account to their agency. You'll sign in with this email address.</p>
<a href="${href}" style="display:inline-block;background:#1d4ed8;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px">Accept Invitation</a>
<p style="color:#94a3b8;font-size:12px;margin:20px 0 0">This invitation expires in ${days} days. If you weren't expecting it, you can safely ignore this email — nothing happens until you accept.</p>`);
}
