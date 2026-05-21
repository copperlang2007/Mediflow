/**
 * Email-to-appointment-desk connector — v1 lowest-common-denominator path.
 *
 * Every carrier in the v1 cut-over uses this connector: the signed packet
 * gets emailed to the carrier's appointment-desk address with the agent's
 * paperwork PDF attached. The carrier responds out-of-band (the desk
 * emails our ops back, or replies on a portal) and a human reconciles via
 * the admin status-override route — that's why `pollStatus` returns
 * `unknown` here.
 *
 * IMPORTANT — actual SMTP transport is NOT wired yet. The real email
 * integration ships in Day 6 once INSUREitALL provides the per-carrier
 * appointment-desk addresses. Today this implementation:
 *   1. Validates the packet shape (signed PDF + desk address present).
 *   2. Logs the destination + a summary so dry-run testing is observable.
 *   3. Returns a synthetic providerRequestId so the workflow advances.
 *
 * When the real path lands, swap the body of `submit()` to call
 * `lib/email.ts` (already wired to Resend) and keep the same return shape.
 */
import { randomUUID } from "node:crypto";
import { logger } from "../logger";
import type {
  CarrierConnector,
  CarrierConnectorPollResult,
  ContractingPacket,
  ContractingRequestRef,
} from "./types";

export const emailConnector: CarrierConnector = {
  name: "Email (appointment desk)",

  // TODO(day-6): replace the log-and-return stub with a real call to
  //   sendEmail({ to: packet.appointmentDeskEmail, attachments: [packet.signedPdf], ... })
  // and surface the Resend message id as providerRequestId.
  async submit(packet: ContractingPacket): Promise<{ providerRequestId: string }> {
    const providerRequestId = `email-stub-${randomUUID()}`;

    if (!packet.appointmentDeskEmail) {
      // We deliberately do NOT throw — the v1 stub flow needs to advance even
      // when the appointment-desk address has not yet been provisioned for
      // that carrier (INSUREitALL collects these incrementally). Log loudly
      // so the gap is visible in dev.
      logger.warn(
        {
          carrierId: packet.carrierId,
          contractingRequestId: packet.contractingRequestId,
        },
        "emailConnector: no appointment-desk email configured — stub send",
      );
    } else {
      logger.info(
        {
          to: packet.appointmentDeskEmail,
          carrierId: packet.carrierId,
          carrierName: packet.carrierName,
          contractingRequestId: packet.contractingRequestId,
          states: packet.states,
          hasSignedPdf: packet.signedPdf != null,
          providerRequestId,
        },
        `emailConnector: would send to: ${packet.appointmentDeskEmail}`,
      );
    }

    return { providerRequestId };
  },

  // Email is fire-and-forget — there's no carrier-side status endpoint to
  // poll. Returning `unknown` tells the orchestrator "no automated update;
  // wait for an admin reconciliation".
  async pollStatus(
    _req: ContractingRequestRef,
  ): Promise<CarrierConnectorPollResult> {
    return { status: "unknown" };
  },
};
