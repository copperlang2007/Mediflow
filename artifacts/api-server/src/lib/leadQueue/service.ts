/**
 * Shared "resolve a carrier + state, then route to the best ready-to-sell and
 * available agent" service. Both the Clerk-authed route (routes/queue.ts) and
 * the HMAC-authed public route (routes/queuePublic.ts) call this so the
 * routing policy can never drift between them — they differ only in how the
 * caller is authenticated and how `orgId` is established.
 */
import { and, eq } from "drizzle-orm";
import { db, contactsTable } from "@workspace/db";
import { resolveCarrier } from "./carriers";
import { getAvailableAgentIds } from "./presence";
import { routeInboundLead, type ReadyToSellAgent } from "./readyToSell";

export interface RouteInboundParams {
  orgId: string;
  carrierId?: string | null;
  carrierName?: string | null;
  contactState?: string | null;
  contactId?: string | null;
  certificationYear?: number;
  requireAhip?: boolean;
  /** Intersect with live presence. Defaults to true. */
  availableOnly?: boolean;
  now?: Date;
}

export interface RouteInboundBody {
  status: "routed" | "no_agent_available";
  stateCode: string;
  carrierId: string;
  candidatePool: number;
  agent: ReadyToSellAgent | null;
  /** Whether a live-presence filter was applied to the pool. */
  presenceFiltered: boolean;
  // Atlas/GHL-compatible flat fields for the "Connect Call" step.
  target_phone: string | null;
  target_user_id: string | null;
}

export type RouteInboundOutcome =
  | { ok: true; body: RouteInboundBody }
  | { ok: false; status: number; error: string };

function normalizeState(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toUpperCase();
  return s.length === 2 ? s : null;
}

const CARRIER_ERROR: Record<
  "missing" | "not_found" | "ambiguous",
  { status: number; error: string }
> = {
  missing: { status: 400, error: "Provide a carrierId or carrierName." },
  not_found: {
    status: 404,
    error: "No active carrier matches the supplied carrierId/carrierName.",
  },
  ambiguous: {
    status: 409,
    error:
      "carrierName matches more than one active carrier — use carrierId to disambiguate.",
  },
};

export async function resolveAndRouteInbound(
  p: RouteInboundParams,
): Promise<RouteInboundOutcome> {
  // 1. Carrier → MediFlow carrier id (org-scoped).
  const carrier = await resolveCarrier({
    orgId: p.orgId,
    carrierId: p.carrierId,
    carrierName: p.carrierName,
  });
  if (!carrier.ok) {
    const mapped = CARRIER_ERROR[carrier.reason];
    return { ok: false, status: mapped.status, error: mapped.error };
  }

  // 2. Lead state: explicit wins, else read from the contact record.
  let state = normalizeState(p.contactState);
  if (!state && p.contactId) {
    const [contact] = await db
      .select({ stateCode: contactsTable.stateCode })
      .from(contactsTable)
      .where(
        and(
          eq(contactsTable.id, p.contactId),
          eq(contactsTable.orgId, p.orgId),
        ),
      )
      .limit(1);
    if (!contact) return { ok: false, status: 404, error: "Contact not found" };
    state = normalizeState(contact.stateCode);
  }
  if (!state) {
    return {
      ok: false,
      status: 400,
      error:
        "Could not determine the lead's state — provide `contactState` (2-letter) or a `contactId` whose contact has a stateCode.",
    };
  }

  // 3. Live presence. `availableOnly` defaults to true. When the org has no
  // presence rows at all (feature not adopted yet) we DON'T filter, so routing
  // keeps working before any agent has ever checked in. Once presence is in
  // use, an empty available set correctly yields no_agent_available.
  let availableAgentIds: string[] | undefined;
  let presenceFiltered = false;
  if (p.availableOnly !== false) {
    const presence = await getAvailableAgentIds(p.orgId, p.now);
    if (presence.configured) {
      availableAgentIds = presence.ids;
      presenceFiltered = true;
    }
  }

  // 4. Rank ready-to-sell ∩ available, pick the head.
  const result = await routeInboundLead({
    orgId: p.orgId,
    stateCode: state,
    carrierId: carrier.carrierId,
    certificationYear: p.certificationYear,
    requireAhip: p.requireAhip,
    availableAgentIds,
    now: p.now,
  });

  return {
    ok: true,
    body: {
      status: result.status,
      stateCode: state,
      carrierId: carrier.carrierId,
      candidatePool: result.candidatePool,
      agent: result.agent,
      presenceFiltered,
      target_phone: result.agent?.phone ?? null,
      target_user_id: result.agent?.agentId ?? null,
    },
  };
}
