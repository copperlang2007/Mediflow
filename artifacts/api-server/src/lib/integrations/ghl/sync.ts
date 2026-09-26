/**
 * GoHighLevel → agencyBRIDGE contact feed.
 *
 * One code path serves both the initial backfill and the scheduled pull: a
 * run asks GHL for contacts updated at or after the org's cursor (null = from
 * the beginning), sorted oldest-first, and advances the cursor after every
 * page. So:
 *   - a first run IS the backfill, and it resumes where it stopped if the
 *     process restarts or it hits the per-run page cap;
 *   - later runs only fetch what changed since.
 * Re-reading a contact is harmless (the cursor boundary is inclusive): the
 * write path is idempotent.
 *
 * Writes use the CSV importer's rules: a contact already linked to its GHL id
 * is updated in place; otherwise the usual dedupe (Medicare ID, email/phone +
 * first name, name + DOB) runs before a new contact is created. Existing data
 * is never overwritten — only blanks are filled — with one exception: GHL's
 * DND flag turns agencyBRIDGE opt-outs ON (never off), because honoring an
 * opt-out is the compliant direction.
 *
 * Config (env, synced from Secret Manager in production):
 *   GHL_SYNC_ORG_IDS                         agencyBRIDGE org ids, separated by "," or ";"
 *   GHL_PRIVATE_INTEGRATION_TOKEN[_<ORGID>]  sub-account Private Integration token (secret)
 *   GHL_LOCATION_ID[_<ORGID>]                GHL sub-account (location) id
 */
import { and, eq, isNull, lt, or, sql, TransactionRollbackError } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db, contactsTable, externalContactLinksTable, ghlSyncStateTable } from "@workspace/db";
import { fillBlanks, loadMatcher, upsertContact, type Tx } from "../../contactImport";
import { interpretPayloadContact } from "../payload";
import { searchContacts, GHL_PAGE_LIMIT, type GhlContact } from "./client";
import { logger } from "../../logger";
import { ghlSyncRunsTotal } from "../../metrics";

export const GHL_SOURCE = "gohighlevel";
/** A run holding the lease longer than this is presumed dead and can be taken over. */
const LEASE_MINUTES = 30;
/** Consecutive per-contact save failures before a run gives up (likely a DB problem, not bad data). */
const MAX_CONSECUTIVE_CONTACT_FAILURES = 5;
/** Per-run page cap (100 contacts/page). A larger backfill continues in the next job. */
export const DEFAULT_MAX_PAGES = 50;

export interface GhlConfig {
  orgId: string;
  token: string;
  locationId: string;
}

function envSuffix(orgId: string): string {
  return orgId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function envFor(base: string, orgId: string): string | undefined {
  return process.env[`${base}_${envSuffix(orgId)}`]?.trim() || process.env[base]?.trim() || undefined;
}

function enabledOrgIds(): string[] {
  return [...new Set((process.env.GHL_SYNC_ORG_IDS ?? "").split(/[,;]/).map((s) => s.trim()).filter(Boolean))];
}

function rawConfig(orgId: string): GhlConfig | null {
  const token = envFor("GHL_PRIVATE_INTEGRATION_TOKEN", orgId);
  const locationId = envFor("GHL_LOCATION_ID", orgId);
  return token && locationId ? { orgId, token, locationId } : null;
}

/** Orgs already warned about (once per process, not every tick). */
const warnedMisconfigured = new Set<string>();
function warnOnce(key: string, log: () => void): void {
  if (warnedMisconfigured.has(key)) return;
  warnedMisconfigured.add(key);
  log();
}

/**
 * Orgs whose GHL config is unsafe to run, because two agencies would read the
 * SAME GHL sub-account (and so copy one agency's contacts into another's):
 *   - their ids collapse to the same env-var suffix ("org-1" / "ORG_1"), so a
 *     per-org override can't tell them apart;
 *   - they resolve to the same location id (typically: several orgs listed
 *     but only the global GHL_LOCATION_ID / token set).
 * Every org involved is refused — there is no safe way to pick a winner.
 */
function unsafeOrgIds(ids: string[]): Map<string, string> {
  const reasons = new Map<string, string>();
  const bySuffix = new Map<string, string[]>();
  const byLocation = new Map<string, string[]>();
  for (const id of ids) {
    const suffix = envSuffix(id);
    bySuffix.set(suffix, [...(bySuffix.get(suffix) ?? []), id]);
    const cfg = rawConfig(id);
    if (cfg) byLocation.set(cfg.locationId, [...(byLocation.get(cfg.locationId) ?? []), id]);
  }
  for (const group of bySuffix.values()) {
    if (group.length > 1) for (const id of group) reasons.set(id, `org ids ${group.join(", ")} map to the same env-var suffix`);
  }
  for (const group of byLocation.values()) {
    if (group.length > 1) for (const id of group) reasons.set(id, `orgs ${group.join(", ")} resolve to the same GHL location`);
  }
  return reasons;
}

export function ghlConfigFor(orgId: string): GhlConfig | null {
  const ids = enabledOrgIds();
  if (!ids.includes(orgId)) return null;
  const unsafe = unsafeOrgIds(ids).get(orgId);
  if (unsafe) {
    warnOnce(`unsafe:${orgId}`, () => logger.error({ orgId, reason: unsafe }, "GHL sync: refusing to sync — set a distinct GHL_LOCATION_ID_<ORGID> / token per org"));
    return null;
  }
  return rawConfig(orgId);
}

export function ghlConfigs(): GhlConfig[] {
  const configs: GhlConfig[] = [];
  for (const id of enabledOrgIds()) {
    const cfg = ghlConfigFor(id);
    if (cfg) configs.push(cfg);
    else if (!rawConfig(id)) {
      warnOnce(`missing:${id}`, () => logger.warn({ orgId: id }, "GHL sync: org listed in GHL_SYNC_ORG_IDS but token or location id is missing"));
    }
  }
  return configs;
}

export interface GhlSyncResult {
  status: "ok" | "more_pending" | "already_running";
  created: number;
  updated: number;
  skipped: number;
  /** Contacts that failed to save and were skipped (also counted in `skipped`). */
  failed: number;
  pages: number;
}

export async function runGhlSync(
  cfg: GhlConfig,
  opts: { full?: boolean; maxPages?: number; fetchImpl?: typeof fetch } = {},
): Promise<GhlSyncResult> {
  const { orgId, locationId } = cfg;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;

  await db.insert(ghlSyncStateTable).values({ orgId, locationId }).onConflictDoNothing();

  // Acquire the lease with a fencing token. Every later write matches on the
  // token, so a run that stalled past the lease window and was taken over can
  // no longer move the cursor or clear the new run's lease.
  const token = randomUUID();
  const leaseCutoff = new Date(Date.now() - LEASE_MINUTES * 60_000);
  const [lease] = await db.update(ghlSyncStateTable)
    .set({ runningSince: new Date(), leaseToken: token })
    .where(and(
      eq(ghlSyncStateTable.orgId, orgId),
      or(isNull(ghlSyncStateTable.runningSince), lt(ghlSyncStateTable.runningSince, leaseCutoff)),
    ))
    .returning();
  if (!lease) return { status: "already_running", created: 0, updated: 0, skipped: 0, failed: 0, pages: 0 };

  const mine = and(eq(ghlSyncStateTable.orgId, orgId), eq(ghlSyncStateTable.leaseToken, token));
  /** Write state only while we still hold the lease; throws if it was taken over. */
  const writeState = async (patch: Partial<typeof ghlSyncStateTable.$inferInsert>) => {
    const done = await db.update(ghlSyncStateTable).set(patch).where(mine)
      .returning({ fullResyncRequestedAt: ghlSyncStateTable.fullResyncRequestedAt });
    if (done.length === 0) throw new LeaseLostError();
    return done[0]!;
  };

  // A full re-sync or a different sub-account starts from the top — reset only
  // now that we hold the lease, so it can't clobber a run already in progress.
  // The stored position is either GHL's searchAfter tuple, or — when GHL sent
  // none — a timestamp plus, only while paging through contacts that all share
  // that exact timestamp, a page number.
  let cursorUpdatedAt = lease.cursorUpdatedAt;
  const stored = lease.cursorSearchAfter as (string | number)[] | { page: number } | null;
  let searchAfter = Array.isArray(stored) ? stored : null;
  let startPage = stored && !Array.isArray(stored) && Number.isInteger(stored.page) ? stored.page : 1;
  let backfillCompletedAt = lease.backfillCompletedAt;
  if (opts.full || lease.fullResyncRequestedAt || lease.locationId !== locationId) {
    cursorUpdatedAt = null;
    searchAfter = null;
    startPage = 1;
    backfillCompletedAt = null;
    await writeState({ locationId, cursorUpdatedAt: null, cursorSearchAfter: null, backfillCompletedAt: null, fullResyncRequestedAt: null });
  }

  let since = cursorUpdatedAt;
  let pageNo = startPage;
  const totals = { created: 0, updated: 0, skipped: 0, failed: 0 };
  let consecutiveFailures = 0;
  let pages = 0;
  let morePending = false;
  let runMax: Date | null = null;

  try {
    for (;;) {
      if (pages >= maxPages) { morePending = true; break; }
      const page = await searchContacts(
        { token: cfg.token, locationId, updatedSince: since, searchAfter, page: pageNo, pageLimit: GHL_PAGE_LIMIT },
        opts.fetchImpl,
      );
      pages++;
      let cursor: Date | null = null;
      for (const gc of page.contacts) {
        let outcome: "created" | "updated" | "skipped";
        try {
          outcome = await db.transaction((tx) => syncOneContact(tx, orgId, gc));
          consecutiveFailures = 0;
        } catch (err) {
          // One malformed contact must not pin the cursor and stall every
          // later run. Skip it (it is re-read whenever GHL updates it again).
          // A streak of failures is more likely the database than the data:
          // stop rather than advance the cursor past contacts never written.
          if (err instanceof LeaseLostError || ++consecutiveFailures >= MAX_CONSECUTIVE_CONTACT_FAILURES) throw err;
          const code = (err as { code?: unknown })?.code;
          logger.warn(
            { orgId, ghlContactId: gc.id, error: err instanceof Error ? err.name : "unknown", code: typeof code === "string" ? code : undefined },
            "GHL sync: skipped a contact that failed to save",
          );
          outcome = "skipped";
          totals.failed++;
        }
        totals[outcome]++;
        const updated = gc.dateUpdated ? new Date(gc.dateUpdated) : null;
        if (updated && !Number.isNaN(updated.getTime()) && (!cursor || updated > cursor)) cursor = updated;
      }
      if (cursor && (!runMax || cursor > runMax)) runMax = cursor;
      searchAfter = page.searchAfter;
      // Persist the exact position after the page is written: a crash re-reads
      // the page rather than skipping it.
      if (searchAfter) {
        // GHL's tuple: advance the timestamp and keep the tuple. Kept even when
        // no contact on the page had a usable dateUpdated, so such a page is
        // never re-read forever.
        await writeState({ ...(cursor ? { cursorUpdatedAt: cursor } : {}), cursorSearchAfter: searchAfter, runningSince: new Date() });
      } else {
        // No tuple: move the filter up to the newest contact written and ask
        // for page 1 again. Page numbers under a fixed filter are unsafe —
        // editing an earlier contact in GHL moves it to the end and shifts
        // every later page, silently skipping one. With the filter advanced,
        // only contacts at or after it are paged, and the only way to leave
        // that set is to be edited, which re-lists the contact later.
        // Contacts at exactly the new timestamp are re-read (idempotent).
        // Page numbers remain only for a page that is entirely one timestamp
        // (a bulk edit), where the filter can't move.
        if (runMax && (!since || runMax > since)) {
          since = runMax;
          pageNo = 1;
        } else {
          pageNo++;
        }
        await writeState({ cursorUpdatedAt: since, cursorSearchAfter: pageNo > 1 ? { page: pageNo } : null, runningSince: new Date() });
      }
      if (page.contacts.length < GHL_PAGE_LIMIT) break;
    }

    const final = await writeState({
      // Window finished without a tuple: next run starts from the newest contact
      // seen, and any page-number position is cleared (it must never outlive
      // its window, or later runs would ask for pages past the end forever).
      ...(!morePending && !searchAfter ? { cursorUpdatedAt: runMax && (!since || runMax > since) ? runMax : since, cursorSearchAfter: null } : {}),
      runningSince: null,
      leaseToken: null,
      lastRunAt: new Date(),
      lastStatus: morePending ? "more_pending" : "ok",
      lastError: null,
      lastRunCreated: totals.created,
      lastRunUpdated: totals.updated,
      lastRunSkipped: totals.skipped,
      ...(!morePending && !backfillCompletedAt ? { backfillCompletedAt: new Date() } : {}),
    });

    logger.info({ orgId, pages, ...totals, morePending }, "GHL sync: run finished");
    ghlSyncRunsTotal.inc({ status: morePending ? "more_pending" : "ok" });
    // A full re-sync was requested while this run held the lease: report more
    // work so the worker starts the re-sync now rather than at the next tick.
    return { status: morePending || final.fullResyncRequestedAt ? "more_pending" : "ok", ...totals, pages };
  } catch (err) {
    if (err instanceof LeaseLostError) {
      ghlSyncRunsTotal.inc({ status: "lease_lost" });
      logger.warn({ orgId }, "GHL sync: lease was taken over by a newer run; stopping without writing state");
      return { status: "already_running", ...totals, pages };
    }
    await db.update(ghlSyncStateTable).set({
      runningSince: null,
      leaseToken: null,
      lastRunAt: new Date(),
      lastStatus: "error",
      lastError: err instanceof Error ? err.message.slice(0, 500) : "Unknown error",
      lastRunCreated: totals.created,
      lastRunUpdated: totals.updated,
      lastRunSkipped: totals.skipped,
    }).where(mine);
    ghlSyncRunsTotal.inc({ status: "error" });
    throw err;
  }
}

/**
 * Ask for a full re-sync. Repeated requests collapse into one: the next run to
 * start honours the flag and clears it. Safe while a run is in progress.
 */
export async function requestFullResync(cfg: GhlConfig): Promise<void> {
  const now = new Date();
  await db.insert(ghlSyncStateTable).values({ orgId: cfg.orgId, locationId: cfg.locationId, fullResyncRequestedAt: now })
    .onConflictDoUpdate({ target: ghlSyncStateTable.orgId, set: { fullResyncRequestedAt: now } });
}

class LeaseLostError extends Error {
  constructor() {
    super("GHL sync lease lost");
    this.name = "LeaseLostError";
  }
}

/** Write one GHL contact. Returns which counter it lands in. */
export async function syncOneContact(tx: Tx, orgId: string, gc: GhlContact): Promise<"created" | "updated" | "skipped"> {
  const interpreted = interpretPayloadContact({
    first_name: gc.firstName ?? "",
    last_name: gc.lastName ?? "",
    full_name: gc.contactName ?? "",
    email: gc.email ?? "",
    phone: gc.phone ?? "",
    dob: gc.dateOfBirth ?? "",
    address1: gc.address1 ?? "",
    city: gc.city ?? "",
    state: gc.state ?? "",
    zip: gc.postalCode ?? "",
    lead_source: gc.source ?? "",
  });
  const contact = interpreted.contact;
  // GHL allows phone-only leads; a contact here needs a first and last name.
  if (!contact || !gc.id) return "skipped";
  contact.tags = [...new Set([...contact.tags, ...(Array.isArray(gc.tags) ? gc.tags : []).filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean)])];
  contact.leadSource ??= "GoHighLevel";
  if (gc.dnd) contact.optOut = true;
  const externalUpdatedAt = gc.dateUpdated ? new Date(gc.dateUpdated) : null;

  const [link] = await tx.select().from(externalContactLinksTable).where(and(
    eq(externalContactLinksTable.orgId, orgId),
    eq(externalContactLinksTable.source, GHL_SOURCE),
    eq(externalContactLinksTable.externalId, gc.id),
  )).limit(1);

  let contactId: string;
  let created = false;
  if (link) {
    // A contact deleted in agencyBRIDGE stays deleted: never refill, re-flag or
    // recreate it. A hard delete leaves the link as a tombstone (contactId null).
    if (!link.contactId) return "skipped";
    const [target] = await tx.select({ deletedAt: contactsTable.deletedAt }).from(contactsTable)
      .where(and(eq(contactsTable.id, link.contactId), eq(contactsTable.orgId, orgId))).limit(1);
    if (!target || target.deletedAt) return "skipped";
    contactId = link.contactId;
    await fillBlanks(tx, orgId, contactId, contact, null);
    // An undated response must not erase the timestamp we already have.
    if (externalUpdatedAt) {
      await tx.update(externalContactLinksTable).set({ externalUpdatedAt })
        .where(eq(externalContactLinksTable.id, link.id));
    }
  } else {
    // Not linked yet. If the only person this matches is one the agency has
    // soft-deleted, record a tombstone link and stop: syncing must not bring a
    // deleted person back as a new live contact.
    const live = (await loadMatcher(orgId, [contact], tx)).find(contact);
    if (!live) {
      const gone = (await loadMatcher(orgId, [contact], tx, { deleted: true })).find(contact);
      if (gone) {
        await tx.insert(externalContactLinksTable).values({
          id: randomUUID(), orgId, source: GHL_SOURCE, externalId: gc.id, contactId: gone.match.id, externalUpdatedAt,
        }).onConflictDoNothing();
        return "skipped";
      }
    }
    // Run the dedupe merge in a savepoint: if it lands on a contact already
    // linked to a DIFFERENT GHL contact (duplicates inside GHL), undo the merge
    // and skip, rather than permanently fusing two GHL records into one person.
    const result = await tx.transaction(async (sp) => {
      const r = await upsertContact(sp, orgId, contact, null);
      if (!r.created) {
        const [other] = await sp.select({ externalId: externalContactLinksTable.externalId }).from(externalContactLinksTable)
          .where(and(
            eq(externalContactLinksTable.orgId, orgId),
            eq(externalContactLinksTable.source, GHL_SOURCE),
            eq(externalContactLinksTable.contactId, r.contactId),
          )).limit(1);
        if (other && other.externalId !== gc.id) {
          logger.warn({ orgId, contactId: r.contactId }, "GHL sync: a second GHL contact matched an already-linked contact; skipped");
          sp.rollback();
        }
      }
      return r;
    }).catch((err: unknown) => {
      if (err instanceof TransactionRollbackError) return null;
      throw err;
    });
    if (!result) return "skipped";
    contactId = result.contactId;
    created = result.created;
    await tx.insert(externalContactLinksTable).values({
      id: randomUUID(), orgId, source: GHL_SOURCE, externalId: gc.id, contactId, externalUpdatedAt,
    }).onConflictDoNothing();
  }

  if (gc.dnd) {
    await tx.update(contactsTable).set({ optOutSms: true, optOutEmail: true })
      .where(and(eq(contactsTable.id, contactId), eq(contactsTable.orgId, orgId), isNull(contactsTable.deletedAt),
        sql`(${contactsTable.optOutSms} = false OR ${contactsTable.optOutEmail} = false)`));
  }
  return created ? "created" : "updated";
}
