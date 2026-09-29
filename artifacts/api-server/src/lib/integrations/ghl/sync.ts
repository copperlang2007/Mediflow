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
 * Sunfire applications: when a contact carries Sunfire enrollment data in its
 * custom fields (INSUREitALL's Odyssey sub-account), the application is
 * imported like an EnrollHere policy (see ghl/sunfire.ts): the enrollment row,
 * the encrypted and versioned application record, the writing agent (by NPN),
 * and fill-blanks contact details. It is attached only to a contact we are
 * sure is this person, never to a weak (household) match.
 *
 * Config (env, synced from Secret Manager in production):
 *   GHL_SYNC_ORG_IDS                         agencyBRIDGE org ids, separated by "," or ";"
 *   GHL_PRIVATE_INTEGRATION_TOKEN[_<ORGID>]  sub-account Private Integration token (secret)
 *   GHL_LOCATION_ID[_<ORGID>]                GHL sub-account (location) id
 */
import { and, eq, isNull, lt, or, sql, TransactionRollbackError } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db, activitiesTable, agentsTable, contactsTable, externalContactLinksTable, ghlSyncStateTable } from "@workspace/db";
import { fillBlanks, loadAgentsByEmail, loadMatcher, mbiHashesFor, upsertContact, type Tx, isStrongMatch } from "../../contactImport";
import { interpretPayloadContact } from "../payload";
import { applyCoverageLifecycle, storeApplication, upsertPolicyEnrollment } from "../enrollhere/applicationStore";
import { searchContacts, listContactCustomFields, GhlApiError, GHL_PAGE_LIMIT, type GhlContact } from "./client";
import { readSunfireApplication, type FieldDefs, type SunfireApplication } from "./sunfire";
import { logger } from "../../logger";
import { ghlSyncRunsTotal } from "../../metrics";

export const GHL_SOURCE = "gohighlevel";
/** A run holding the lease longer than this is presumed dead and can be taken over. */
export const LEASE_MINUTES = 30;
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
  // A requested re-sync waits while a window is mid-continuation (the last
  // run stopped at the page cap): restarting it would redo pages this cycle
  // already wrote. The flag stays set and is honoured once the window ends.
  const wantsFull = !!opts.full || !!lease.fullResyncRequestedAt;
  const midWindow = lease.lastStatus === "more_pending" && lease.locationId === locationId;
  if (wantsFull && midWindow) {
    if (!lease.fullResyncRequestedAt) await writeState({ fullResyncRequestedAt: new Date() });
  } else if (wantsFull || lease.locationId !== locationId) {
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
  let failedOnPage = 0;
  let morePending = false;
  let runMax: Date | null = null;
  /** Custom field definitions, fetched once per run and only when a contact carries custom fields. */
  let defs: FieldDefs | null = null;

  try {
    for (;;) {
      if (pages >= maxPages) { morePending = true; break; }
      const page = await searchContacts(
        { token: cfg.token, locationId, updatedSince: since, searchAfter, page: pageNo, pageLimit: GHL_PAGE_LIMIT },
        opts.fetchImpl,
      );
      pages++;
      if (!defs && page.contacts.some((c) => Array.isArray(c.customFields) && c.customFields.length > 0)) {
        defs = await loadFieldDefs(cfg, opts.fetchImpl);
      }
      let cursor: Date | null = null;
      failedOnPage = 0;
      for (const gc of page.contacts) {
        let outcome: "created" | "updated" | "skipped";
        try {
          outcome = await db.transaction((tx) => syncOneContact(tx, orgId, gc, defs ?? undefined));
          consecutiveFailures = 0;
        } catch (err) {
          // One malformed contact must not pin the cursor and stall every
          // later run. Skip it (it is re-read whenever GHL updates it again).
          // A streak of failures is more likely the database than the data:
          // stop rather than advance the cursor past contacts never written.
          // Postgres data (22xxx) and constraint (23xxx) errors are about this
          // contact's values, so they never count toward the streak.
          const code = (err as { code?: unknown; cause?: { code?: unknown } })?.code ?? (err as { cause?: { code?: unknown } })?.cause?.code;
          // A TypeError/RangeError with no code means GHL sent a field in an
          // unexpected shape (e.g. an object where a string belongs): also
          // about this contact. A code bug would fail every contact instead,
          // which the whole-page check below catches.
          const dataError = (typeof code === "string" && /^2[23]/.test(code))
            || (code === undefined && (err instanceof TypeError || err instanceof RangeError));
          if (err instanceof LeaseLostError || (!dataError && ++consecutiveFailures >= MAX_CONSECUTIVE_CONTACT_FAILURES)) throw err;
          logger.warn(
            { orgId, ghlContactId: gc.id, error: err instanceof Error ? err.name : "unknown", code: typeof code === "string" ? code : undefined },
            "GHL sync: skipped a contact that failed to save",
          );
          outcome = "skipped";
          totals.failed++;
          failedOnPage++;
        }
        totals[outcome]++;
        const updated = gc.dateUpdated ? new Date(gc.dateUpdated) : null;
        if (updated && !Number.isNaN(updated.getTime()) && (!cursor || updated > cursor)) cursor = updated;
      }
      // Every contact on a full page failing is not bad data, it's us (a bug or
      // an outage): stop without advancing past contacts never written.
      if (page.contacts.length >= 5 && failedOnPage === page.contacts.length) {
        throw new Error(`GHL sync: all ${failedOnPage} contacts on a page failed to save; stopped without advancing`);
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
      // The tuple is cleared too when there's a timestamp to resume from: a
      // contact later updated at exactly the cursor timestamp but sorting
      // before the tuple's id would otherwise be skipped. Re-reading contacts
      // at that one timestamp is idempotent. With no timestamp at all, keep the
      // tuple so undated contacts aren't re-read from the start forever.
      ...(!morePending
        ? (runMax || since
          ? { cursorUpdatedAt: runMax && (!since || runMax > since) ? runMax : since, cursorSearchAfter: null }
          : searchAfter ? {} : { cursorSearchAfter: null })
        : {}),
      runningSince: null,
      leaseToken: null,
      lastRunAt: new Date(),
      lastStatus: morePending ? "more_pending" : "ok",
      lastError: null,
      lastRunCreated: totals.created,
      lastRunUpdated: totals.updated,
      lastRunSkipped: totals.skipped,
      lastRunFailed: totals.failed,
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
      lastError: safeErrorMessage(err),
      lastRunCreated: totals.created,
      lastRunUpdated: totals.updated,
      lastRunSkipped: totals.skipped,
      lastRunFailed: totals.failed,
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

/**
 * Error text for the admin status panel. Database errors carry the failed
 * statement's parameters (contact names, emails, phones) after "params:";
 * those never leave the server.
 */
export function safeErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return "Unknown error";
  const code = (err as { code?: unknown; cause?: { code?: unknown } }).code ?? (err as { cause?: { code?: unknown } }).cause?.code;
  if (/failed query|params:/i.test(err.message) || typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
    return `Database error while saving contacts${typeof code === "string" ? ` (code ${code})` : ""}`;
  }
  return err.message.split(/\r?\nparams:/, 1)[0]!.slice(0, 500);
}

/**
 * The sub-account's custom field definitions (id → name and merge key). A
 * token without the custom-fields scope (401/403) syncs contacts only; any
 * other failure fails the run before the cursor moves, so no application is
 * skipped over.
 */
async function loadFieldDefs(cfg: GhlConfig, fetchImpl?: typeof fetch): Promise<FieldDefs> {
  try {
    const fields = await listContactCustomFields({ token: cfg.token, locationId: cfg.locationId }, fetchImpl);
    return new Map(fields.filter((f) => f.fieldKey).map((f) => [f.id, { name: f.name, key: f.fieldKey! }]));
  } catch (err) {
    if (err instanceof GhlApiError && (err.status === 401 || err.status === 403)) {
      warnOnce(`fields:${cfg.orgId}`, () => logger.warn({ orgId: cfg.orgId, status: err.status }, "GHL sync: custom fields not readable (token lacks locations/customFields.readonly); Sunfire applications are not imported"));
      return new Map();
    }
    throw err;
  }
}

class LeaseLostError extends Error {
  constructor() {
    super("GHL sync lease lost");
    this.name = "LeaseLostError";
  }
}

/** Write one GHL contact. Returns which counter it lands in. */
export async function syncOneContact(
  tx: Tx,
  orgId: string,
  gc: GhlContact,
  defs: FieldDefs = new Map(),
): Promise<"created" | "updated" | "skipped"> {
  let application = defs.size > 0 ? readSunfireApplication(gc, defs) : null;
  const [link] = await tx.select().from(externalContactLinksTable).where(and(
    eq(externalContactLinksTable.orgId, orgId),
    eq(externalContactLinksTable.source, GHL_SOURCE),
    eq(externalContactLinksTable.externalId, gc.id),
  )).limit(1);
  // An application whose Medicare ID differs from the linked contact's is
  // someone else's: none of it (identifiers, details, agent) touches them.
  if (application && link?.contactId && await mbiConflicts(tx, orgId, link.contactId, application.parsed.medicareNumber)) {
    logger.warn({ orgId, contactId: link.contactId }, "GHL sync: Sunfire application's Medicare ID differs from the contact's; not attached");
    application = null;
  }
  const flat: Record<string, string> = {
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
  };
  // The application's Medicare ID, birth date and county fill what the
  // standard fields leave blank (and a Medicare ID makes the match exact).
  for (const [k, v] of Object.entries(application?.contactFlat ?? {})) if (!flat[k]) flat[k] = v;
  const interpreted = interpretPayloadContact(flat);
  const contact = interpreted.contact;
  // GHL allows phone-only leads; a contact here needs a first and last name.
  if (!contact || !gc.id) return "skipped";
  contact.tags = [...new Set([...contact.tags, ...(Array.isArray(gc.tags) ? gc.tags : []).filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean)])];
  contact.leadSource ??= "GoHighLevel";
  if (gc.dnd) contact.optOut = true;
  const parsedUpdated = gc.dateUpdated ? new Date(gc.dateUpdated) : null;
  const externalUpdatedAt = parsedUpdated && !Number.isNaN(parsedUpdated.getTime()) ? parsedUpdated : null;

  let contactId: string;
  let created = false;
  /** Same person beyond doubt: the same GHL record, a new contact, or a strong match. */
  let sureOfIdentity = false;
  if (link) {
    // A contact deleted in agencyBRIDGE stays deleted: never refill, re-flag or
    // recreate it. A hard delete leaves the link as a tombstone (contactId null).
    if (!link.contactId) return "skipped";
    const [target] = await tx.select({ deletedAt: contactsTable.deletedAt }).from(contactsTable)
      .where(and(eq(contactsTable.id, link.contactId), eq(contactsTable.orgId, orgId))).limit(1);
    if (!target || target.deletedAt) return "skipped";
    contactId = link.contactId;
    sureOfIdentity = true;
    await fillBlanks(tx, orgId, contactId, contact, null);
    // An undated response must not erase the timestamp we already have.
    // external_dnd is only written when GHL actually sent a boolean (an omitted
    // or null value leaves what we know untouched), and a stored true is never
    // turned back off here, like the contact opt-outs. An explicit false only
    // replaces unknown (null).
    const dndPatch = typeof gc.dnd === "boolean"
      ? { externalDnd: gc.dnd ? true : sql`coalesce(${externalContactLinksTable.externalDnd}, false)` }
      : {};
    if (externalUpdatedAt || Object.keys(dndPatch).length > 0) {
      await tx.update(externalContactLinksTable)
        .set({ ...(externalUpdatedAt ? { externalUpdatedAt } : {}), ...dndPatch })
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
        // A name + date-of-birth match whose email or phone disagree is a
        // different person who happens to share them: import normally.
        const conflicts = gone.reason === "name + date of birth" && (
          (!!contact.email && !!gone.match.email && contact.email.toLowerCase() !== gone.match.email.toLowerCase()) ||
          (!!contact.phone && !!gone.match.phone && contact.phone !== gone.match.phone)
        );
        if (!conflicts) {
          // Permanent only when two independent facts agree: the Medicare ID,
          // or a birth date AND an email/phone. Name + birth date alone (Sr/Jr,
          // twins, coincidence) is held like a weak match.
          const sameContact = (!!contact.email && !!gone.match.email && contact.email.toLowerCase() === gone.match.email.toLowerCase())
            || (!!contact.phone && !!gone.match.phone && contact.phone === gone.match.phone);
          if (gone.reason === "Medicare ID" || (isStrongMatch(gone.reason, contact.dob, gone.match.dob) && sameContact)) {
            // Clearly the deleted person: link permanently so they stay deleted.
            await tx.insert(externalContactLinksTable).values({
              id: randomUUID(), orgId, source: GHL_SOURCE, externalId: gc.id, contactId: gone.match.id, externalUpdatedAt,
            }).onConflictDoNothing();
          } else {
            // Only a shared email/phone + name (e.g. parent and child in one
            // household). Don't recreate a deleted person, but don't bind this
            // GHL record to them forever either: hold it unlinked, so it is
            // re-checked on its next update (or once the deleted record is gone).
            logger.warn({ orgId, ghlContactId: gc.id, reason: gone.reason }, "GHL sync: held a contact that weakly matches a deleted contact");
          }
          return "skipped";
        }
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
    if (created) {
      sureOfIdentity = true;
    } else if (result.matchedOn) {
      const [existing] = await tx.select({ dob: contactsTable.dob }).from(contactsTable).where(eq(contactsTable.id, contactId)).limit(1);
      sureOfIdentity = isStrongMatch(result.matchedOn, contact.dob, existing?.dob ? existing.dob.toISOString().slice(0, 10) : null);
    }
    await tx.insert(externalContactLinksTable).values({
      id: randomUUID(), orgId, source: GHL_SOURCE, externalId: gc.id, contactId, externalUpdatedAt,
      // Recorded even when DND could not be applied below (weak identity match).
      externalDnd: typeof gc.dnd === "boolean" ? gc.dnd : null,
    }).onConflictDoNothing();
  }

  // DND only flips opt-outs on a contact we're sure is this person: merging
  // on a shared household phone/email + name must not opt out a relative.
  if (gc.dnd && !sureOfIdentity) {
    logger.info({ orgId, ghlContactId: gc.id }, "GHL sync: DND not applied to a contact matched without a birth date or Medicare ID");
  }
  if (gc.dnd && sureOfIdentity) {
    await tx.update(contactsTable).set({ optOutSms: true, optOutEmail: true })
      .where(and(eq(contactsTable.id, contactId), eq(contactsTable.orgId, orgId), isNull(contactsTable.deletedAt),
        sql`(${contactsTable.optOutSms} = false OR ${contactsTable.optOutEmail} = false)`));
  }
  if (application) {
    if (sureOfIdentity) await importSunfireApplication(tx, orgId, contactId, application);
    else logger.info({ orgId, ghlContactId: gc.id }, "GHL sync: Sunfire application not attached to a contact matched without a birth date or Medicare ID");
  }
  return created ? "created" : "updated";
}

/** The contact has a Medicare ID on file and it isn't `mbi`. */
async function mbiConflicts(tx: Tx, orgId: string, contactId: string, mbi: string | null): Promise<boolean> {
  if (!mbi) return false;
  const [cur] = await tx.select({ medicareIdHash: contactsTable.medicareIdHash }).from(contactsTable)
    .where(and(eq(contactsTable.id, contactId), eq(contactsTable.orgId, orgId))).limit(1);
  return !!cur?.medicareIdHash && !mbiHashesFor(mbi).some((h) => h.equals(Buffer.from(cur.medicareIdHash!)));
}

/**
 * The writing agent: by NPN (the reliable identifier across Sunfire and
 * agencyBRIDGE), else by email. An offboarded agent is used only when no
 * current agent carries the NPN.
 */
async function findWritingAgent(
  tx: Tx,
  orgId: string,
  npn: string | null,
  email: string | null,
): Promise<{ id: string; userId: string | null } | null> {
  const digits = npn?.replace(/\D/g, "");
  if (digits) {
    const rows = await tx.select({ id: agentsTable.id, userId: agentsTable.userId, status: agentsTable.status })
      .from(agentsTable)
      .where(and(eq(agentsTable.orgId, orgId), sql`regexp_replace(coalesce(${agentsTable.npn}, ''), '[^0-9]', '', 'g') = ${digits}`));
    const pick = rows.find((r) => r.status !== "offboarded") ?? rows[0];
    if (pick) return { id: pick.id, userId: pick.userId };
  }
  if (email) {
    const id = (await loadAgentsByEmail(orgId, tx, email)).get(email) ?? null;
    if (id) {
      const [row] = await tx.select({ userId: agentsTable.userId }).from(agentsTable).where(eq(agentsTable.id, id)).limit(1);
      return { id, userId: row?.userId ?? null };
    }
  }
  return null;
}

/**
 * Write a Sunfire application read from a GHL contact: the enrollment, the
 * coverage lifecycle, the encrypted application record, fill-blanks contact
 * details and qualifying health conditions, and an activity when the
 * application is new or changed.
 */
async function importSunfireApplication(
  tx: Tx,
  orgId: string,
  contactId: string,
  app: SunfireApplication,
): Promise<void> {
  const p = app.parsed;
  // A different Medicare ID on file means this application is someone else's
  // (a contact merged on a shared phone or email): never attach PHI, or assign
  // its agent, to the wrong person.
  if (await mbiConflicts(tx, orgId, contactId, p.medicareNumber)) {
    logger.warn({ orgId, contactId }, "GHL sync: Sunfire application's Medicare ID differs from the contact's; not attached");
    return;
  }
  const [cur] = await tx.select({
    assignedAgentId: contactsTable.assignedAgentId,
    healthConditions: contactsTable.healthConditions,
    pcpName: contactsTable.pcpName,
    preferredLanguage: contactsTable.preferredLanguage,
  }).from(contactsTable).where(and(eq(contactsTable.id, contactId), eq(contactsTable.orgId, orgId))).limit(1);
  if (!cur) return;

  const agent = await findWritingAgent(tx, orgId, p.agentNpn, p.agentEmail);
  const agentId = agent?.id ?? null;
  const enrollmentId = await upsertPolicyEnrollment(tx, orgId, contactId, agentId, p, "From Odyssey (Sunfire)");
  await applyCoverageLifecycle(tx, contactId, enrollmentId, p.policyStatus);
  const stored = await storeApplication(tx, orgId, p, { contactId, enrollmentId }, { source: GHL_SOURCE, fallbackKey: app.fallbackKey });

  const conditions = [...new Set([...(cur.healthConditions ?? []), ...app.healthConditions])];
  const patch: Partial<typeof contactsTable.$inferInsert> = {};
  if (conditions.length !== (cur.healthConditions ?? []).length) patch.healthConditions = conditions;
  if (!cur.assignedAgentId && agentId) patch.assignedAgentId = agentId;
  if (!cur.pcpName && app.pcpName) patch.pcpName = app.pcpName;
  if (!cur.preferredLanguage && app.preferredLanguage) patch.preferredLanguage = app.preferredLanguage;
  if (Object.keys(patch).length > 0) {
    await tx.update(contactsTable).set(patch).where(and(eq(contactsTable.id, contactId), eq(contactsTable.orgId, orgId)));
  }

  if (stored?.newVersion) {
    const summary = [
      `Odyssey (Sunfire): application ${stored.version > 1 ? "updated" : "received"}`,
      p.planName ? ` — ${p.planName}` : null,
      p.effectiveDate ? `, effective ${p.effectiveDate}` : null,
      p.policyStatus ? ` (${p.policyStatus.replace(/_/g, " ").toLowerCase()})` : null,
    ].filter(Boolean).join("");
    await tx.insert(activitiesTable).values({
      id: randomUUID(),
      orgId,
      contactId,
      agentId,
      createdBy: agent?.userId ?? null,
      type: "enrollment",
      body: summary,
      metadata: {
        source: GHL_SOURCE,
        eventType: p.eventType,
        enrollmentId,
        applicationId: stored.applicationId,
        applicationVersion: stored.version,
      },
    });
  }
}
