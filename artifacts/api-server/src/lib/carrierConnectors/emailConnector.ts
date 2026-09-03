/**
 * Email-to-appointment-desk connector.
 *
 * Every carrier in the v1 cut-over uses this connector: the signed packet is
 * emailed to the carrier's appointment-desk address with the agent's paperwork
 * PDF attached. The carrier responds out of band (the desk emails ops back, or
 * replies on a portal) and a human reconciles via the admin status-override
 * route — which is why `pollStatus` returns `unknown`.
 *
 * ## Why this used to be dangerous
 *
 * This connector previously logged "would send to: …", returned a synthetic
 * `email-stub-<uuid>` id, and let the workflow advance to `submitted`. Nothing
 * was ever transmitted. The agency saw a carrier appointment request marked as
 * sent while no carrier had received anything — a silent failure at the exact
 * point where an agent's ability to write business depends on the paperwork
 * actually arriving.
 *
 * ## What it does now
 *
 * It sends, via `lib/email.ts` (Resend), and it refuses to report success it
 * did not earn:
 *
 *  - No appointment-desk address, or email not configured → throws. The
 *    request stays in its prior state and surfaces as a failure rather than
 *    advancing on a lie.
 *  - Send fails → throws with the provider's error.
 *  - Send succeeds → returns the real Resend message id as
 *    `providerRequestId`, so a delivery can be traced.
 *
 * Dry runs are still possible, but only when asked for explicitly:
 * `CARRIER_EMAIL_CONNECTOR_DRY_RUN=true` restores log-and-advance behavior and
 * marks the id `dry-run-…` so it can never be mistaken for a real submission.
 */
import { randomUUID } from "node:crypto";

import { logger } from "../logger";
import { sendEmail, isEmailConfigured } from "../email";
import type {
  CarrierConnector,
  CarrierConnectorPollResult,
  ContractingPacket,
  ContractingRequestRef,
} from "./types";

function isDryRun(): boolean {
  return process.env.CARRIER_EMAIL_CONNECTOR_DRY_RUN === "true";
}

/**
 * Body for the appointment desk.
 *
 * Deliberately carries only what the desk needs to identify the request — the
 * SSN/EIN and the rest of the profile stay in the attached packet, which is
 * where the carrier expects them, rather than in a mail body that gets quoted
 * into reply chains.
 */
function composeBody(packet: ContractingPacket): string {
  const states = packet.states.length ? packet.states.join(", ") : "not specified";
  return [
    `New agent appointment request — ${packet.carrierName}`,
    "",
    `Agent: ${packet.profile.firstName} ${packet.profile.lastName}`,
    `NPN: ${packet.profile.npn ?? "not provided"}`,
    `Requested states: ${states}`,
    `Reference: ${packet.contractingRequestId}`,
    "",
    packet.signedPdf
      ? "The signed contracting packet is attached as a PDF."
      : "NOTE: no signed packet PDF was available for this request.",
    "",
    "Please reply to this address to confirm receipt or request corrections.",
  ].join("\n");
}

/** Minimal escaping — the body is assembled from our own fields, not user HTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export const emailConnector: CarrierConnector = {
  name: "Email (appointment desk)",

  async submit(
    packet: ContractingPacket,
  ): Promise<{ providerRequestId: string }> {
    if (isDryRun()) {
      logger.warn(
        {
          to: packet.appointmentDeskEmail,
          carrierId: packet.carrierId,
          contractingRequestId: packet.contractingRequestId,
        },
        "emailConnector: DRY RUN — nothing was transmitted to the carrier",
      );
      return { providerRequestId: `dry-run-${randomUUID()}` };
    }

    if (!packet.appointmentDeskEmail) {
      // Advancing here is what made the old behavior unsafe: the request would
      // read as submitted with no destination on record.
      throw new Error(
        `No appointment-desk email is configured for carrier ${packet.carrierName} (${packet.carrierId}). ` +
          `Set it before submitting, or set CARRIER_EMAIL_CONNECTOR_DRY_RUN=true to rehearse the flow.`,
      );
    }

    if (!isEmailConfigured()) {
      throw new Error(
        "RESEND_API_KEY is not set — cannot transmit a carrier appointment request. " +
          "Set it, or set CARRIER_EMAIL_CONNECTOR_DRY_RUN=true to rehearse the flow.",
      );
    }

    const result = await sendEmail({
      to: { email: packet.appointmentDeskEmail },
      subject: `Agent appointment request — ${packet.carrierName} — ref ${packet.contractingRequestId}`,
      text: composeBody(packet),
      html: `<pre style="font-family:ui-monospace,monospace;white-space:pre-wrap">${escapeHtml(
        composeBody(packet),
      )}</pre>`,
      ...(packet.signedPdf
        ? {
            attachments: [
              {
                filename: `contracting-packet-${packet.contractingRequestId}.pdf`,
                content: packet.signedPdf,
                contentType: "application/pdf",
              },
            ],
          }
        : {}),
    });

    if (!result.success) {
      throw new Error(
        `Email send to appointment desk failed for carrier ${packet.carrierName}: ${result.error}`,
      );
    }

    logger.info(
      {
        to: packet.appointmentDeskEmail,
        carrierId: packet.carrierId,
        contractingRequestId: packet.contractingRequestId,
        providerRequestId: result.id,
        hasSignedPdf: packet.signedPdf != null,
      },
      "emailConnector: appointment request transmitted",
    );

    return { providerRequestId: result.id };
  },

  // Email is fire-and-forget — there is no carrier-side status endpoint to
  // poll. `unknown` tells the orchestrator "no automated update; wait for an
  // admin reconciliation".
  async pollStatus(
    _req: ContractingRequestRef,
  ): Promise<CarrierConnectorPollResult> {
    return { status: "unknown" };
  },
};
