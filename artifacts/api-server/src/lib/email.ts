/**
 * Email client (Resend).
 *
 * Provides a typed interface for sending transactional emails.
 * The Resend API key must be set as RESEND_API_KEY in environment secrets.
 *
 * All send operations are fire-and-forget safe — they never throw synchronously;
 * failures are logged and can be retried via the job queue.
 */

import { logger } from "./logger";

export type EmailRecipient = { email: string; name?: string };

export interface SendEmailOptions {
  to: EmailRecipient | EmailRecipient[];
  subject: string;
  html: string;
  text?: string;
  from?: string;
  replyTo?: string;
  tags?: Record<string, string>;
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

function isConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

/**
 * Send a transactional email via Resend.
 * Returns a result object — never throws.
 */
export async function sendEmail(
  opts: SendEmailOptions,
): Promise<EmailResult | EmailError> {
  if (!isConfigured()) {
    logger.warn("RESEND_API_KEY not set — email not sent");
    return { success: false, error: "Email not configured" };
  }

  const toArray = Array.isArray(opts.to) ? opts.to : [opts.to];
  const toAddresses = toArray.map((r) =>
    r.name ? `${r.name} <${r.email}>` : r.email,
  );

  const payload = {
    from: opts.from ?? DEFAULT_FROM,
    to: toAddresses,
    subject: opts.subject,
    html: opts.html,
    ...(opts.text ? { text: opts.text } : {}),
    ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
    ...(opts.tags ? { tags: Object.entries(opts.tags).map(([k, v]) => ({ name: k, value: v })) } : {}),
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

// ----- Template helpers -----

export function licenseExpiryEmailHtml(opts: {
  agentName: string;
  stateCode: string;
  licenseType: string;
  daysUntilExpiry: number;
  expiryDate: string;
}): string {
  const urgency = opts.daysUntilExpiry <= 30 ? "URGENT: " : "";
  return `
<div style="font-family: Inter, sans-serif; max-width: 560px; margin: 0 auto; color: #0f172a;">
  <div style="background: #1e3a5f; padding: 24px 32px;">
    <h1 style="color: #fff; margin: 0; font-size: 20px;">MediFlow</h1>
  </div>
  <div style="padding: 32px; background: #fff; border: 1px solid #e2e8f0;">
    <h2 style="margin-top: 0; font-size: 18px;">${urgency}License Expiring in ${opts.daysUntilExpiry} days</h2>
    <p>Hi ${opts.agentName},</p>
    <p>Your <strong>${opts.stateCode} ${opts.licenseType}</strong> license is expiring on <strong>${opts.expiryDate}</strong>.</p>
    <p style="margin-bottom: 0; color: #64748b; font-size: 13px;">This is an automated alert from MediFlow.</p>
  </div>
</div>`.trim();
}

export function ahipReminderEmailHtml(opts: {
  agentName: string;
  certificationYear: number;
}): string {
  return `
<div style="font-family: Inter, sans-serif; max-width: 560px; margin: 0 auto; color: #0f172a;">
  <div style="background: #1e3a5f; padding: 24px 32px;">
    <h1 style="color: #fff; margin: 0; font-size: 20px;">MediFlow</h1>
  </div>
  <div style="padding: 32px; background: #fff; border: 1px solid #e2e8f0;">
    <h2 style="margin-top: 0; font-size: 18px;">AHIP Certification Reminder</h2>
    <p>Hi ${opts.agentName},</p>
    <p>Your AHIP certification for <strong>${opts.certificationYear}</strong> has not been completed. Please complete it to remain eligible to sell Medicare products.</p>
    <p style="margin-bottom: 0; color: #64748b; font-size: 13px;">This is an automated alert from MediFlow.</p>
  </div>
</div>`.trim();
}
