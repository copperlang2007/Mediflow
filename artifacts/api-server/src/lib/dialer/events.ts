/**
 * Dialer → agencyBRIDGE event envelope + type catalogue (spec §6).
 *
 * Forward-compatibility is a hard requirement (§6.2): consumers MUST ignore
 * unknown fields and unknown event types. We therefore validate only the
 * envelope shell with a passthrough schema (unknown keys are preserved, not
 * rejected) and treat `type` as an open string — the dispatcher branches on
 * the known set and no-ops on anything else.
 */
import { z } from "zod/v4";

/** Known event types (§6). The wire `type` is an OPEN string. */
export const KNOWN_EVENT_TYPES = [
  "call.initiated",
  "call.ringing",
  "call.in_progress",
  "call.completed",
  "call.failed",
  "call.disposition.recorded",
  "call.transcript.ready",
  "call.transcript.purged",
  "call.compliance.flagged",
] as const;

export type KnownEventType = (typeof KNOWN_EVENT_TYPES)[number];

export function isKnownEventType(type: string): type is KnownEventType {
  return (KNOWN_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * Envelope schema. `.passthrough()` keeps unknown top-level fields (forward
 * compat); `data` is an open record for the same reason. `type` is a plain
 * string so an unknown type still parses — it's the dispatcher's job to
 * ignore it.
 */
export const dialerEventEnvelopeSchema = z
  .object({
    eventId: z.string().min(1),
    schemaVersion: z.number().optional(),
    type: z.string().min(1),
    occurredAt: z.string().optional(),
    orgId: z.string().min(1),
    dialTicketId: z.string().optional(),
    dialerCallId: z.string().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type DialerEventEnvelope = z.infer<typeof dialerEventEnvelopeSchema>;
