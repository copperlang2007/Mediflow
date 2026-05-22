/**
 * Day-6 contracting email-out worker.
 *
 * Drains the `${carrierRequestId}:submit` system tasks created by the
 * e-sign completion path (`lib/esign/carrierSignCallback.ts`) and emails
 * the signed contracting packet to the carrier's appointment desk.
 *
 * Trigger model — DIRECT ENQUEUE.
 *   `carrierSignCallback.completeCarrierSigningTransition` enqueues a job
 *   into `JOB_NAMES.SUBMIT_CONTRACTING_PACKET` right after it creates the
 *   submit task. Faster than polling, simpler than wiring a periodic scan.
 *   If a job ever gets stuck (e.g. a deploy bounced mid-handler before
 *   commit) the admin dashboard surfaces the still-open submit task and an
 *   admin can re-enqueue by hand — the worker is idempotent on the request
 *   status so the second run is a no-op against an already-submitted row.
 *
 * Idempotency — belt-and-braces.
 *   1. The enqueue site passes `singletonKey: "submit:${requestId}"` so
 *      pg-boss collapses concurrent enqueues to a single in-flight job.
 *   2. THIS handler reads the carrier_contracting_request status at entry
 *      and exits cleanly if the row is already `submitted` (or beyond) —
 *      so a job that races past the singleton window still no-ops.
 *
 * Failure model.
 *   - Missing/cross-org request id → log + exit (cannot retry into success).
 *   - Carrier `appointment_desk_email` IS NULL → WARN log, leave the submit
 *     task OPEN, do NOT advance state, do NOT throw. INSUREitALL is filling
 *     these in incrementally; "data not yet configured" is a normal state
 *     in the rollout, not a system failure that should burn retries.
 *   - Resend send fails → throw. pg-boss retries per `DEFAULT_RETRY`
 *     (3 attempts, exponential backoff). After retries exhaust, the shared
 *     dead-letter queue logs + Sentry-captures.
 *
 * PII hygiene.
 *   The signed PDF + email body contain SSN, DOB, address. We never include
 *   the attachment bytes or the email body in any log line. Logs carry only
 *   the request id, carrier id, masked recipient address, and structural
 *   metadata (size in bytes, send success).
 */
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  db,
  agentsTable,
  agentContractingProfilesTable,
  agentOnboardingRunsTable,
  auditLogTable,
  carrierContractingRequestsTable,
  carriersTable,
  esignEnvelopesTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { sendEmail } from "../lib/email";
import {
  canTransitionContracting,
  type ContractingStatus,
} from "./contractingStateMachine";
import { closeContractingTask, carrierSubmitTaskKey } from "./contractingTasks";
import {
  maybeAdvanceRunForRequests,
} from "../lib/esign/carrierSignCallback";
import { getMediflowProvider } from "../lib/esign/mediflowProvider";

/**
 * Statuses where the worker exits cleanly — the carrier-side workflow has
 * already moved past `signed`. A duplicate job (e.g. a singleton-race miss
 * or an admin re-enqueue after a stuck state) should not re-send the email.
 */
const ALREADY_DISPATCHED: ReadonlySet<ContractingStatus> = new Set([
  "submitted",
  "under_review",
  "appointed",
  "rejected",
  "cancelled",
]);

/**
 * Documented shape of `carriers.appointment_desk_metadata`. The column is
 * `jsonb default {}` and not strictly validated at the DB level — the
 * carriers PATCH route validates the documented keys on write, but we
 * defensively re-check here in case a legacy row slipped through.
 */
interface AppointmentDeskMetadata {
  cc?: string[];
  subject?: string;
}

export interface SubmitContractingPacketInput {
  carrierContractingRequestId: string;
  orgId: string;
}

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readMetadata(raw: unknown): AppointmentDeskMetadata {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const m = raw as Record<string, unknown>;
  const out: AppointmentDeskMetadata = {};
  if (Array.isArray(m.cc)) {
    out.cc = m.cc.filter(
      (v): v is string => typeof v === "string" && EMAIL_RX.test(v),
    );
  }
  if (typeof m.subject === "string" && m.subject.length > 0) {
    out.subject = m.subject;
  }
  return out;
}

function maskEmail(addr: string): string {
  // Logging emails in full is fine for our threat model (the addresses are
  // configured carrier-side, not contact PII), but masking is cheap and
  // future-proofs the log line if we ever co-mingle agent recipients here.
  const at = addr.indexOf("@");
  if (at <= 1) return "***";
  return `${addr[0]}***${addr.slice(at)}`;
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function coverLetterHtml(opts: {
  agentName: string;
  npn: string | null;
  carrierName: string;
  states: string[];
  integritySha256: string | null;
}): string {
  const states = opts.states.length > 0 ? opts.states.join(", ") : "(no states listed)";
  const npn = opts.npn ? `<p>NPN: <strong>${htmlEscape(opts.npn)}</strong></p>` : "";
  const integrity = opts.integritySha256
    ? `<p style="color:#64748b;font-size:12px">Signed packet attached. SHA-256: <code>${htmlEscape(opts.integritySha256)}</code>.</p>`
    : `<p style="color:#64748b;font-size:12px">Signed packet attached.</p>`;
  return `
<p>Hello ${htmlEscape(opts.carrierName)} appointment desk,</p>
<p>Please find attached the signed contracting paperwork for the following agent:</p>
<ul>
  <li>Agent: <strong>${htmlEscape(opts.agentName)}</strong></li>
  ${npn ? `<li>${npn.replace(/<\/?p[^>]*>/g, "")}</li>` : ""}
  <li>States: <strong>${htmlEscape(states)}</strong></li>
</ul>
${integrity}
<p>Thank you,<br/>MediFlow on behalf of the agent's agency</p>
`.trim();
}

function coverLetterText(opts: {
  agentName: string;
  npn: string | null;
  carrierName: string;
  states: string[];
  integritySha256: string | null;
}): string {
  const lines = [
    `Hello ${opts.carrierName} appointment desk,`,
    "",
    "Please find attached the signed contracting paperwork for the following agent:",
    `  Agent: ${opts.agentName}`,
  ];
  if (opts.npn) lines.push(`  NPN: ${opts.npn}`);
  lines.push(`  States: ${opts.states.join(", ") || "(no states listed)"}`);
  lines.push("");
  if (opts.integritySha256) {
    lines.push(`Signed packet attached. SHA-256: ${opts.integritySha256}.`);
  } else {
    lines.push("Signed packet attached.");
  }
  lines.push("");
  lines.push("Thank you,");
  lines.push("MediFlow on behalf of the agent's agency");
  return lines.join("\n");
}

/**
 * Worker entrypoint. Throws on Resend send failures so pg-boss retries
 * kick in; returns silently on "data not yet configured" (null
 * appointment-desk email) so the dead-letter queue isn't polluted with
 * normal rollout state.
 */
export async function submitContractingPacketWorker(
  input: SubmitContractingPacketInput,
): Promise<void> {
  const { carrierContractingRequestId: requestId, orgId } = input;

  // 1. Load the request (org-scoped). A foreign-org / typo request id
  //    yields no row → exit cleanly with a warn (cannot retry into
  //    success, no point burning retries).
  const [request] = await db
    .select()
    .from(carrierContractingRequestsTable)
    .where(
      and(
        eq(carrierContractingRequestsTable.id, requestId),
        eq(carrierContractingRequestsTable.orgId, orgId),
      ),
    )
    .limit(1);
  if (!request) {
    logger.warn(
      { requestId, orgId },
      "submitContractingPacket: carrier_contracting_request not found (cross-org or deleted) — exiting",
    );
    return;
  }

  // 2. Idempotency: if the row already moved past `signed`, this is a
  //    duplicate enqueue. Exit clean — no email, no state change.
  if (ALREADY_DISPATCHED.has(request.status as ContractingStatus)) {
    logger.info(
      { requestId, orgId, status: request.status },
      "submitContractingPacket: request already past `signed` — no-op",
    );
    return;
  }

  // 3. The state machine only allows `signed → submitted`. A request that
  //    hasn't reached `signed` yet (e.g. `draft` / `paperwork_generated`)
  //    isn't ready — log + exit. The route-side e-sign flow will enqueue
  //    again once it does flip to `signed`.
  if (!canTransitionContracting(request.status as ContractingStatus, "submitted")) {
    logger.warn(
      { requestId, orgId, status: request.status },
      "submitContractingPacket: request not in a state that can transition to `submitted` — skipping",
    );
    return;
  }

  // 4. Load the carrier (org-scoped) — needed for the destination email +
  //    metadata + the cover letter's carrier-name interpolation.
  const [carrier] = await db
    .select()
    .from(carriersTable)
    .where(
      and(
        eq(carriersTable.id, request.carrierId),
        eq(carriersTable.orgId, orgId),
      ),
    )
    .limit(1);
  if (!carrier) {
    // Shouldn't happen (FK guarantees row exists in org during normal
    // operation, but a manual carrier delete is theoretically possible).
    logger.warn(
      { requestId, orgId, carrierId: request.carrierId },
      "submitContractingPacket: carrier row missing — skipping",
    );
    return;
  }

  // 5. Appointment-desk address not yet configured. INSUREitALL fills
  //    these in incrementally; we WARN-log + leave the submit task open
  //    so an admin (or the worker on next enqueue) can pick up where we
  //    left off once the address lands.
  const deskEmail = carrier.appointmentDeskEmail;
  if (!deskEmail || !EMAIL_RX.test(deskEmail)) {
    logger.warn(
      {
        requestId,
        orgId,
        carrierId: carrier.id,
        carrierName: carrier.name,
        hasAddress: Boolean(deskEmail),
      },
      "submitContractingPacket: appointment_desk_email not configured — leaving submit task open for retry once admin sets the address",
    );
    return;
  }

  // 6. Load the signed envelope + signed-PDF document so we can pull the
  //    integrity hash + the attachment bytes.
  const [envelope] = await db
    .select()
    .from(esignEnvelopesTable)
    .where(
      and(
        eq(esignEnvelopesTable.carrierContractingRequestId, requestId),
        eq(esignEnvelopesTable.orgId, orgId),
      ),
    )
    .limit(1);
  if (!envelope || envelope.status !== "completed" || !envelope.signedPdfDocumentId) {
    // Request says `signed` but envelope row is missing or not completed
    // — inconsistent state, can't retry into success without admin
    // intervention. Log + exit so dead-letter doesn't fire.
    logger.warn(
      {
        requestId,
        orgId,
        envelopeStatus: envelope?.status,
        hasSignedPdf: Boolean(envelope?.signedPdfDocumentId),
      },
      "submitContractingPacket: no completed envelope/signed PDF for a request in `signed` state — skipping",
    );
    return;
  }

  // 7. Fetch the signed PDF bytes through the e-sign provider (same code
  //    path that powers the admin "view signed PDF" route — handles both
  //    GCS-backed and InMemoryEsignStorage in tests).
  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await getMediflowProvider().getSignedPdf(envelope.id, orgId);
  } catch (err) {
    logger.error(
      { err, requestId, orgId, envelopeId: envelope.id },
      "submitContractingPacket: failed to load signed PDF bytes",
    );
    throw err;
  }

  // 8. Load the agent + their contracting profile for the cover letter.
  //    NPN lives on `agents`; lack of an NPN is normal at this point so
  //    we just omit the line.
  const [agent] = await db
    .select()
    .from(agentsTable)
    .where(
      and(
        eq(agentsTable.id, request.agentId),
        eq(agentsTable.orgId, orgId),
      ),
    )
    .limit(1);
  const agentName = agent
    ? `${agent.firstName} ${agent.lastName}`.trim()
    : "(unknown agent)";
  const npn = agent?.npn ?? null;
  // Profile lookup is optional — we don't include profile fields in the
  // cover letter (PII), only the NPN. Left here as a seam in case Day-7+
  // wants to surface a couple of non-PII fields in the cover.
  const [_profile] = await db
    .select({ agentId: agentContractingProfilesTable.agentId })
    .from(agentContractingProfilesTable)
    .where(eq(agentContractingProfilesTable.agentId, request.agentId))
    .limit(1);
  void _profile;

  // 9. Build + send the email. Subject template can come from carrier
  //    metadata; default falls back to the documented format.
  const metadata = readMetadata(carrier.appointmentDeskMetadata);
  const defaultSubject = `New contracting submission: ${agentName} — ${carrier.name}`;
  const subject = metadata.subject ?? defaultSubject;
  const cc = (metadata.cc ?? []).map((email) => ({ email }));
  const fromAddr =
    process.env.CONTRACTING_EMAIL_FROM ??
    process.env.EMAIL_FROM_ADDRESS ??
    "noreply@mediflow.app";

  const filename = `${agentName.replace(/[^a-zA-Z0-9._-]/g, "_") || "agent"}-${carrier.name.replace(/[^a-zA-Z0-9._-]/g, "_") || "carrier"}-signed.pdf`;

  const sendResult = await sendEmail({
    to: { email: deskEmail },
    cc: cc.length > 0 ? cc : undefined,
    from: fromAddr,
    subject,
    html: coverLetterHtml({
      agentName,
      npn,
      carrierName: carrier.name,
      states: request.states ?? [],
      integritySha256: envelope.integritySha256,
    }),
    text: coverLetterText({
      agentName,
      npn,
      carrierName: carrier.name,
      states: request.states ?? [],
      integritySha256: envelope.integritySha256,
    }),
    attachments: [
      {
        filename,
        content: pdfBuffer,
        contentType: "application/pdf",
      },
    ],
    tags: {
      kind: "contracting-submission",
      carrierId: carrier.id,
      requestId,
    },
  });

  if (!sendResult.success) {
    // Throw so pg-boss retries per DEFAULT_RETRY. After retries exhaust,
    // dead-letter logs + Sentry capture.
    const msg = `Email send to appointment desk failed: ${sendResult.error}`;
    logger.error(
      {
        requestId,
        orgId,
        carrierId: carrier.id,
        to: maskEmail(deskEmail),
        error: sendResult.error,
      },
      msg,
    );
    throw new Error(msg);
  }

  // 10. Transition the carrier_contracting_request to `submitted`.
  //     Status-gated so a concurrent worker can't double-write — we only
  //     update WHERE the row is still in `signed`.
  const now = new Date();
  const [updated] = await db
    .update(carrierContractingRequestsTable)
    .set({
      status: "submitted",
      submittedAt: now,
      lastStatusChangeAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(carrierContractingRequestsTable.id, requestId),
        eq(carrierContractingRequestsTable.orgId, orgId),
        eq(carrierContractingRequestsTable.status, "signed"),
      ),
    )
    .returning();

  if (!updated) {
    // Race: another worker won the transition between our check and our
    // update. The email was already sent (theirs would have sent too if
    // they also passed the status check). Both senders are functionally
    // identical from the carrier's perspective and the singleton+status
    // gate makes this vanishingly rare; we log + continue to clean up.
    logger.info(
      { requestId, orgId },
      "submitContractingPacket: status transition lost a race — proceeding to task close + run advance",
    );
  }

  // 11. Audit log — a background worker writes its own row since the
  //     auditMiddleware only runs on HTTP requests.
  await db.insert(auditLogTable).values({
    id: randomUUID(),
    orgId,
    userId: null,
    userRole: "system",
    action: "update",
    resourceType: "carrier_contracting",
    resourceId: requestId,
    changes: {
      worker: "submitContractingPacket",
      transition: { from: "signed", to: "submitted" },
      // Recipient address recorded so an auditor can prove which desk
      // received the packet. NOT the attachment bytes — those stay
      // out of the audit log.
      submittedTo: deskEmail,
      ccCount: cc.length,
      integritySha256: envelope.integritySha256,
    },
  });

  // 12. Close the submit task. Idempotent via the status-gated UPDATE in
  //     `closeContractingTask`.
  await closeContractingTask(orgId, carrierSubmitTaskKey(requestId));

  // 13. Roll the onboarding run forward. When the LAST request in the run
  //     hits `submitted` (or beyond), this transitions
  //     `signing → submitted`; when ALL are `appointed`, it advances to
  //     `complete` and fires the operator notification.
  await maybeAdvanceRunForRequests(request.onboardingRunId, orgId);

  // Run lookup is implicit in maybeAdvanceRunForRequests; we only need to
  // verify the row actually exists for the log line below.
  const [run] = await db
    .select({ id: agentOnboardingRunsTable.id })
    .from(agentOnboardingRunsTable)
    .where(
      and(
        eq(agentOnboardingRunsTable.id, request.onboardingRunId),
        eq(agentOnboardingRunsTable.orgId, orgId),
      ),
    )
    .limit(1);

  logger.info(
    {
      requestId,
      orgId,
      carrierId: carrier.id,
      to: maskEmail(deskEmail),
      ccCount: cc.length,
      pdfBytes: pdfBuffer.byteLength,
      runId: run?.id ?? null,
    },
    "submitContractingPacket: signed packet emailed to appointment desk",
  );
}
