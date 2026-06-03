/**
 * Agent presence read/write helpers for the inbound lead queue.
 *
 * See lib/db/src/schema/presence.ts for the model. Two writers:
 *   - `recordHeartbeat`     — the web app; the ONLY path that sets `available`.
 *   - `recordDialerPresence`/`markPresenceForTicket` — dialer call-state events
 *     flip `on_call` / `wrap` (fail-closed; never `available`).
 *
 * Availability is read with `getAvailableAgentIds`, which the queue route
 * intersects with the ready-to-sell pool. TTL is enforced here at read time.
 */
import { eq } from "drizzle-orm";
import { db, agentPresenceTable, dialTicketsTable } from "@workspace/db";

/** Heartbeat freshness window. The web app should re-ping well inside this. */
export const HEARTBEAT_TTL_SECONDS = ttlFromEnv(
  "LEAD_QUEUE_HEARTBEAT_TTL_SECONDS",
  90,
);
/**
 * How long a dialer-driven busy/free state is trusted without a fresh event.
 * Generous so a missed terminal event doesn't thrash, but bounded so a stuck
 * `on_call` eventually yields to the agent's heartbeat.
 */
export const DIALER_TTL_SECONDS = ttlFromEnv(
  "LEAD_QUEUE_DIALER_TTL_SECONDS",
  900,
);

function ttlFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export type PresenceStatus =
  | "available"
  | "on_call"
  | "wrap"
  | "away"
  | "offline";

/** Statuses a heartbeat is allowed to assert (the agent's own intent). */
export const HEARTBEAT_STATUSES: readonly PresenceStatus[] = [
  "available",
  "away",
  "offline",
];

/**
 * Upsert an agent's self-reported presence (heartbeat). Returns the row.
 * `available`/`away` set a fresh TTL; `offline` clears it (immediately gone
 * from the pool).
 */
export async function recordHeartbeat(args: {
  orgId: string;
  agentId: string;
  status: PresenceStatus;
  ttlSeconds?: number;
  now?: Date;
}) {
  const { orgId, agentId, status } = args;
  const now = args.now ?? new Date();
  const ttl = args.ttlSeconds ?? HEARTBEAT_TTL_SECONDS;
  const expiresAt =
    status === "offline" ? null : new Date(now.getTime() + ttl * 1000);

  const [row] = await db
    .insert(agentPresenceTable)
    .values({
      agentId,
      orgId,
      status,
      source: "heartbeat",
      lastSeenAt: now,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: agentPresenceTable.agentId,
      set: {
        status,
        source: "heartbeat",
        lastSeenAt: now,
        expiresAt,
        // Keep the row's org in sync (cheap; agents don't move orgs in
        // practice, but this avoids a stale org pinning a presence row).
        orgId,
      },
    })
    .returning();
  return row;
}

/**
 * Upsert presence from an authoritative dialer call-state event. Never sets
 * `available` — only the heartbeat does. A row is created lazily if the agent
 * has never heartbeat (so an on-call agent is correctly excluded even if their
 * tab is closed).
 */
export async function recordDialerPresence(args: {
  orgId: string;
  agentId: string;
  status: Exclude<PresenceStatus, "available">;
  eventId?: string | null;
  ttlSeconds?: number;
  now?: Date;
}): Promise<void> {
  const { orgId, agentId, status } = args;
  const now = args.now ?? new Date();
  const ttl = args.ttlSeconds ?? DIALER_TTL_SECONDS;
  const expiresAt = new Date(now.getTime() + ttl * 1000);

  await db
    .insert(agentPresenceTable)
    .values({
      agentId,
      orgId,
      status,
      source: "dialer",
      lastEventId: args.eventId ?? null,
      lastSeenAt: now,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: agentPresenceTable.agentId,
      set: {
        status,
        source: "dialer",
        lastEventId: args.eventId ?? null,
        lastSeenAt: now,
        expiresAt,
        orgId,
      },
    });
}

/**
 * Resolve the agent behind a dial ticket and apply a dialer presence status.
 * No-op when the ticket is unknown or has no agent attached.
 */
export async function markPresenceForTicket(args: {
  dialTicketId: string;
  status: Exclude<PresenceStatus, "available">;
  eventId?: string | null;
  now?: Date;
}): Promise<void> {
  const [ticket] = await db
    .select({
      agentId: dialTicketsTable.agentId,
      orgId: dialTicketsTable.orgId,
    })
    .from(dialTicketsTable)
    .where(eq(dialTicketsTable.id, args.dialTicketId))
    .limit(1);
  if (!ticket?.agentId) return;
  await recordDialerPresence({
    orgId: ticket.orgId,
    agentId: ticket.agentId,
    status: args.status,
    eventId: args.eventId,
    now: args.now,
  });
}

export interface AvailabilityResult {
  /** True when the org has ANY presence row (i.e. presence is in use). */
  configured: boolean;
  /** Agent ids currently available (status='available' and not expired). */
  ids: string[];
}

/**
 * Agents reachable right now in an org. `configured` lets the caller
 * distinguish "presence is in use but nobody is free" (route to nobody) from
 * "presence not adopted yet" (don't filter at all) — see the route.
 */
export async function getAvailableAgentIds(
  orgId: string,
  now: Date = new Date(),
): Promise<AvailabilityResult> {
  const rows = await db
    .select({
      agentId: agentPresenceTable.agentId,
      status: agentPresenceTable.status,
      expiresAt: agentPresenceTable.expiresAt,
    })
    .from(agentPresenceTable)
    .where(eq(agentPresenceTable.orgId, orgId));

  const ids = rows
    .filter(
      (r) =>
        r.status === "available" && (r.expiresAt === null || r.expiresAt > now),
    )
    .map((r) => r.agentId);

  return { configured: rows.length > 0, ids };
}

export const __testing = { ttlFromEnv };
