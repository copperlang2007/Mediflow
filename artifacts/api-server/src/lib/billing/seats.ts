/**
 * Seat accounting — what the per-seat line on the invoice actually counts.
 *
 * A **seat is a login**: one active row in `users`. It is deliberately not an
 * `agents` row. Those are different populations and conflating them would
 * misbill in both directions:
 *
 *  - An agency's roster (`agents`) includes licensed producers who never sign
 *    in — downline agents whose licensing and AHIP the agency tracks on their
 *    behalf. Charging a seat for each would price the product against a number
 *    the buyer does not think of as "users".
 *  - Conversely a compliance manager or an agency admin has a login and no
 *    agent record at all, and would ride free.
 *
 * `plan.limits.agents` still caps roster size; that is a different limit with a
 * different purpose, enforced separately by `requireCapacity`.
 *
 * **A pending invitation holds a seat.** The alternative — counting only
 * accepted users — moves the failure from the admin, who can buy more seats or
 * revoke an invite, to the invitee, who opens a link and is told there is no
 * room. Reserving at invite time also makes the count monotonic: an admin
 * cannot issue ten invitations against three seats and discover the problem
 * only as people trickle in.
 *
 * ## Why the entitlement is re-read under the lock
 *
 * `getEntitlements` reads through the module-level `db` handle and caches for
 * 30s. Calling it from inside a transaction issues that read on a *different*
 * connection than the one holding the seat lock — which under pglite (a single
 * connection) deadlocks outright, and under a real pool reads outside the
 * transaction's snapshot. But resolving it *before* the lock is not safe
 * either: a downgrade committing in between leaves the check enforcing a stale,
 * larger limit, and the cache can make that window 30s wide.
 *
 * So `requireSeat` reads the `subscriptions` row on the connection it was
 * handed — inside the lock, in the transaction's own snapshot — and maps it
 * through the same `deriveEntitlements` that `getEntitlements` uses, so the two
 * can never disagree. Everything under a lock touches only that connection.
 */
import { and, count, eq, gt, ne, sql } from "drizzle-orm";
import { type PlanTier } from "./plans";
import {
  db,
  usersTable,
  userInvitationsTable,
  subscriptionsTable,
} from "@workspace/db";

import {
  getEntitlements,
  deriveEntitlements,
  PlanLimitError,
} from "./entitlements";

/** A Drizzle transaction handle, structurally identical to `db` for queries. */
type DbLike =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface SeatCounts {
  /** Active logins. */
  activeUsers: number;
  /** Unexpired, unrevoked invitations — each reserving a seat. */
  pendingInvitations: number;
  /** `activeUsers + pendingInvitations`. */
  used: number;
}

export interface SeatUsage extends SeatCounts {
  /** Seats the org is entitled to. */
  limit: number;
  /** `limit - used`, floored at zero. */
  available: number;
}

/**
 * Counts seats consumed by an org on the given connection.
 *
 * Pending invitations count only while genuinely live: an invitation past
 * `expires_at` may not have been swept to `expired` yet (that happens lazily,
 * on read) but must not keep holding a seat, so the expiry is applied in the
 * predicate rather than trusting the status column alone.
 *
 * `excludeInvitationId` leaves one invitation out of the count. Accepting an
 * invitation converts the seat it already holds into a member, so the accept
 * path must not count that same reservation against itself.
 */
export async function countSeatsUsed(
  orgId: string,
  conn: DbLike = db,
  opts: { excludeInvitationId?: string } = {},
): Promise<SeatCounts> {
  // Sequential, not Promise.all: these may run inside a transaction, and a
  // single connection cannot serve two statements concurrently.
  const users = await conn
    .select({ n: count() })
    .from(usersTable)
    .where(and(eq(usersTable.orgId, orgId), eq(usersTable.isActive, true)));

  const invites = await conn
    .select({ n: count() })
    .from(userInvitationsTable)
    .where(
      and(
        eq(userInvitationsTable.orgId, orgId),
        eq(userInvitationsTable.status, "pending"),
        gt(userInvitationsTable.expiresAt, sql`now()`),
        opts.excludeInvitationId
          ? ne(userInvitationsTable.id, opts.excludeInvitationId)
          : undefined,
      ),
    );

  const activeUsers = Number(users[0]?.n ?? 0);
  const pendingInvitations = Number(invites[0]?.n ?? 0);

  return { activeUsers, pendingInvitations, used: activeUsers + pendingInvitations };
}

/**
 * Full seat picture for an org. Resolves the entitlement itself, so call it
 * *outside* a transaction (see the module note).
 */
export async function getSeatUsage(orgId: string): Promise<SeatUsage> {
  const ent = await getEntitlements(orgId);
  const counts = await countSeatsUsed(orgId, db);
  return {
    ...counts,
    limit: ent.seats,
    available: Math.max(0, ent.seats - counts.used),
  };
}

/**
 * Reads the org's seat entitlement on the given connection, bypassing the
 * cache. Call only while holding the seat lock — see the module note.
 */
export async function seatEntitlementOn(
  orgId: string,
  conn: DbLike,
): Promise<{ seats: number; tier: PlanTier }> {
  const [row] = await conn
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.orgId, orgId))
    .limit(1);

  const ent = deriveEntitlements(orgId, row ?? null);
  return { seats: ent.seats, tier: ent.tier };
}

/**
 * Asserts the org has room for one more seat, throwing `PlanLimitError` (402)
 * when it does not.
 *
 * Both the limit and the count are read on `conn`, so a downgrade that commits
 * while this transaction waits on the lock is seen, not missed.
 *
 * Pass `excludeInvitationId` when the seat being claimed is the one that
 * invitation already holds (accepting it). Without that, an invitation that
 * filled the plan's last seat counts against itself and can never be accepted.
 * A downgrade is still caught: if the plan shrank below the other members and
 * reservations, there is no room even once this one is set aside.
 */
export async function requireSeat(
  orgId: string,
  conn: DbLike,
  opts: { excludeInvitationId?: string } = {},
): Promise<SeatCounts> {
  const { seats: limit, tier } = await seatEntitlementOn(orgId, conn);
  const counts = await countSeatsUsed(orgId, conn, opts);
  if (counts.used < limit) return counts;

  throw new PlanLimitError(
    `All ${limit} seats on your plan are in use. Revoke a pending invitation, deactivate a user, or upgrade to add more.`,
    { tier, limit, current: counts.used },
  );
}

/**
 * Serializes seat arithmetic for one org within the calling transaction.
 *
 * Counting rows does not lock them, so two concurrent invitations against the
 * last free seat would both read one available and both succeed. A
 * transaction-scoped advisory lock keyed on the org id makes check-then-insert
 * atomic without introducing a row to contend on (orgs on the free tier may
 * have no `subscriptions` row to lock). It is released automatically at commit
 * or rollback.
 *
 * Call this first inside any transaction that consumes or frees a seat.
 */
export async function lockOrgSeats(orgId: string, conn: DbLike): Promise<void> {
  await conn.execute(sql`select pg_advisory_xact_lock(hashtext(${orgId}))`);
}
