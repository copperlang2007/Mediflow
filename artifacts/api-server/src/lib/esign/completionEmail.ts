/**
 * Certificate-of-completion email for completed e-sign envelopes.
 *
 * Phase-3 hardening: after `MediflowESignProvider.recordSignature` finishes
 * transitioning an envelope to `completed`, every signer with a non-empty
 * email receives a copy of the signed PDF + a reference to the document
 * integrity hash. This is the ESIGN §101(c) "consumer disclosure" record
 * that closes the loop on the signing flow.
 *
 * Design notes:
 *   - Fire-and-forget: the signing flow MUST NOT fail if email send fails.
 *     The caller wraps this in try/catch + Sentry capture (same pattern as
 *     `enqueue` from PR #73).
 *   - One audit-log event per signer attempt (success OR failure) so the
 *     `esign_signing_events` trail captures whether the signer was actually
 *     notified. Event type: `certificate_of_completion_emailed`.
 *   - Idempotency: the caller is responsible for checking the existing
 *     event log and skipping the send on a re-completion. This module just
 *     does the send + writes the event row.
 *   - Cross-org safety: this helper only sees envelope-scoped data passed
 *     in by the caller; it makes no cross-org queries.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db,
  esignSigningEventsTable,
  type EsignEnvelope,
  type EnvelopeSigner,
} from "@workspace/db";
import { sendEmail } from "../email";
import { logger } from "../logger";

export interface CertificateEmailOptions {
  /**
   * Override the document display name used in the subject line. Falls back
   * to `"agencyBRIDGE document"` when not provided.
   */
  documentName?: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildHtml(opts: {
  signerName: string;
  documentName: string;
  integritySha256: string;
}): string {
  const name = escapeHtml(opts.signerName);
  const doc = escapeHtml(opts.documentName);
  const hash = escapeHtml(opts.integritySha256);
  return `
<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px;font-family:Inter,system-ui,sans-serif;background:#f1f5f9">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #e2e8f0;padding:28px 32px">
    <h2 style="margin:0 0 12px;font-size:18px;color:#0f172a">Thank you for signing</h2>
    <p style="color:#475569;margin:0 0 12px">Hi ${name},</p>
    <p style="color:#475569;margin:0 0 16px">
      Thank you for signing <strong>${doc}</strong>. Attached is your record
      of the signed agreement, including the audit certificate page.
    </p>
    <p style="color:#475569;margin:0 0 16px;font-size:13px">
      Document integrity hash (SHA-256):<br>
      <code style="font-family:Menlo,Consolas,monospace;font-size:12px;color:#0f172a;word-break:break-all">${hash}</code>
    </p>
    <p style="color:#64748b;font-size:12px;margin:0">
      If you have questions, please contact your agency administrator.
    </p>
  </div>
</body></html>`.trim();
}

function buildText(opts: {
  signerName: string;
  documentName: string;
  integritySha256: string;
}): string {
  return [
    `Hi ${opts.signerName},`,
    "",
    `Thank you for signing ${opts.documentName}. Attached is your record of the signed agreement, including the audit certificate page.`,
    "",
    `Document integrity hash (SHA-256): ${opts.integritySha256}`,
    "",
    "If you have questions, please contact your agency administrator.",
  ].join("\n");
}

/**
 * Send a certificate-of-completion email to every signer on the envelope
 * who has a non-empty email address. Writes one
 * `certificate_of_completion_emailed` event per attempt (success or
 * failure) to the audit trail.
 *
 * Never throws. Returns the count of attempts so the caller can log it.
 */
export async function sendCertificateOfCompletion(
  envelope: EsignEnvelope,
  signedPdfBytes: Buffer,
  integritySha256: string,
  opts: CertificateEmailOptions = {},
): Promise<{ attempts: number; sent: number }> {
  const documentName = opts.documentName ?? "agencyBRIDGE document";
  const subject = `Signed: ${documentName}`;
  const filename = `signed-${envelope.id}.pdf`;
  const signers = (envelope.signers as EnvelopeSigner[]) ?? [];

  // Idempotency guard: if any `certificate_of_completion_emailed` event
  // already exists for this envelope, we've already attempted delivery
  // — do not re-send on a re-completion. The provider's `completed`
  // short-circuit branch already avoids this code path on idempotent
  // re-signs, but this guard is defense in depth in case a future
  // caller reaches this helper through a different path.
  try {
    const existing = await db
      .select({ id: esignSigningEventsTable.id })
      .from(esignSigningEventsTable)
      .where(
        and(
          eq(esignSigningEventsTable.envelopeId, envelope.id),
          eq(
            esignSigningEventsTable.eventType,
            "certificate_of_completion_emailed",
          ),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      logger.info(
        { envelopeId: envelope.id },
        "sendCertificateOfCompletion: already attempted — skipping",
      );
      return { attempts: 0, sent: 0 };
    }
  } catch (err) {
    // If the check itself fails we proceed with the send rather than
    // skip — better to risk a duplicate notification than to silently
    // drop a real one.
    logger.warn(
      { err, envelopeId: envelope.id },
      "sendCertificateOfCompletion: idempotency check failed — proceeding with send",
    );
  }

  let attempts = 0;
  let sent = 0;

  for (const signer of signers) {
    const email = (signer.email ?? "").trim();
    if (!email) continue; // skip signers with no email — no audit row either

    attempts += 1;
    const html = buildHtml({
      signerName: signer.displayName || "there",
      documentName,
      integritySha256,
    });
    const text = buildText({
      signerName: signer.displayName || "there",
      documentName,
      integritySha256,
    });

    let success = false;
    let errorMessage: string | undefined;
    try {
      const result = await sendEmail({
        to: { email, name: signer.displayName },
        subject,
        html,
        text,
        attachments: [
          {
            filename,
            content: signedPdfBytes,
            contentType: "application/pdf",
          },
        ],
        tags: {
          kind: "esign-completion-certificate",
          envelopeId: envelope.id,
        },
      });
      if (result.success) {
        success = true;
        sent += 1;
      } else {
        errorMessage = result.error;
      }
    } catch (err) {
      // sendEmail is documented as never-throw, but defense-in-depth:
      // if it ever does, we still want a single audit row + zero
      // re-throw so the caller's fire-and-forget contract holds.
      errorMessage = (err as Error).message;
      logger.warn(
        { err, envelopeId: envelope.id, signerUserId: signer.userId },
        "sendCertificateOfCompletion: unexpected throw from sendEmail",
      );
    }

    // Audit row: one per attempt, regardless of success. The append-only
    // trigger on esign_signing_events makes this row tamper-evident.
    try {
      await db.insert(esignSigningEventsTable).values({
        id: randomUUID(),
        orgId: envelope.orgId,
        envelopeId: envelope.id,
        eventType: "certificate_of_completion_emailed",
        actorUserId: null,
        eventData: {
          signerUserId: signer.userId,
          email,
          success,
          ...(errorMessage ? { error: errorMessage } : {}),
        },
      });
    } catch (err) {
      // Best-effort audit write — don't let an audit-row insert failure
      // bubble. The send already happened (or didn't); a missing event
      // row is preferable to throwing out of a fire-and-forget hook.
      logger.warn(
        { err, envelopeId: envelope.id, signerUserId: signer.userId },
        "sendCertificateOfCompletion: failed to write audit event row",
      );
    }
  }

  return { attempts, sent };
}
