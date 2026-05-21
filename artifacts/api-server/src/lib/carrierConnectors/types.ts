/**
 * CarrierConnector abstraction.
 *
 * Carriers receive contracting paperwork through wildly different channels:
 *  - some accept an email to the appointment desk with the signed PDF
 *    attached (v1 — the lowest-common-denominator integration)
 *  - some have a "broker portal" REST API
 *  - one (Aetna) accepts a SOAP feed
 *
 * The `CarrierConnector` interface hides that mess from the rest of the
 * codebase: routes and workers know how to build a `ContractingPacket` from
 * an `agent_contracting_profiles` row + a signed PDF, hand it to a
 * connector, and later ask `pollStatus` for an update. Whether the
 * underlying transport is an email or an API call is an implementation
 * detail of the connector itself.
 *
 * Phase-2 plan: swap individual carriers from `emailConnector` to native
 * connectors (e.g. `aetnaConnector`) one carrier at a time in `index.ts`,
 * with zero call-site changes.
 */

/** Address shape used in the connector packet — flat, no zod runtime cost. */
export interface PacketAddress {
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

/**
 * Carrier-facing snapshot of the agent. Connectors must NOT receive the
 * full `agent_contracting_profiles` row directly — they only get the fields
 * the carrier actually needs, AND the SSN/EIN are passed as decrypted
 * plaintext strings because the carrier transport (email body, REST POST,
 * etc.) needs them in cleartext.
 *
 * That decryption happens at the call-site, immediately before the packet
 * is constructed, so the plaintext is only ever in memory while the request
 * is in flight.
 */
export interface AgentContractingPacketProfile {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  ssn: string | null;
  dob: string | null; // ISO yyyy-mm-dd
  npn: string | null;
  homeAddress: PacketAddress;
  mailingAddress: PacketAddress | null;
  entityType: string | null;
  businessName: string | null;
  ein: string | null;
  eAndO: {
    carrier: string | null;
    policyNumber: string | null;
    expiresOn: string | null;
  };
}

export interface ContractingPacket {
  carrierId: string;
  carrierName: string;
  contractingRequestId: string;
  agentId: string;
  states: string[];
  profile: AgentContractingPacketProfile;
  /**
   * Signed paperwork PDF, ready to attach/upload to the carrier. NULL for
   * the v1 stub flow that has no real templates yet — connectors must
   * handle that explicitly and either bail or send a placeholder.
   */
  signedPdf: Buffer | null;
  /**
   * Appointment-desk contact info (per-carrier, per-org). Sourced from the
   * carriers table once that column is added in Days 3+. For v1 the email
   * connector logs whatever the caller provides and returns a synthetic id.
   */
  appointmentDeskEmail: string | null;
  /** Free-form metadata bag the carrier desk might want — e.g. "writing as W-2". */
  appointmentDeskMetadata: Record<string, unknown>;
}

export type CarrierResponseStatus =
  | "acknowledged"
  | "under_review"
  | "appointed"
  | "rejected"
  | "unknown";

export interface CarrierConnectorPollResult {
  status: CarrierResponseStatus;
  /** Carrier-specific raw payload — stashed verbatim in
   * `carrier_contracting_requests.carrier_response_data`. */
  data?: unknown;
}

/**
 * Minimal context the connector needs from the live request row.
 * Kept narrow so emailConnector tests don't have to construct a full DB row.
 */
export interface ContractingRequestRef {
  id: string;
  carrierId: string;
  signatureEnvelopeId: string | null;
  providerRequestId?: string | null;
}

export interface CarrierConnector {
  /** Human-readable label — surfaced in admin UI + logs. */
  name: string;
  /**
   * Hand the signed packet to the carrier. Returns the provider's request id
   * (e.g. an email Message-ID for the email connector, or a portal request
   * UUID for a future REST connector). The caller persists this id so
   * pollStatus can find the carrier-side state later.
   */
  submit(packet: ContractingPacket): Promise<{ providerRequestId: string }>;
  /**
   * Poll the carrier for the latest status of an in-flight request. For
   * connectors with no polling capability (email is a one-shot fire-and-
   * forget) this returns `{ status: "unknown" }` and the carrier's response
   * is captured later out-of-band via admin status-override.
   */
  pollStatus(req: ContractingRequestRef): Promise<CarrierConnectorPollResult>;
}
