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
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db, contactsTable, externalContactLinksTable, ghlSyncStateTable } from "@workspace/db";
import { fillBlanks, upsertContact, type Tx } from "../../contactImport";
import { interpretPayloadContact } from "../payload";
import { searchContacts, GHL_PAGE_LIMIT, type GhlContact } from "./client";
import { logger } from "../../logger";

export const GHL_SOURCE = "gohighlevel";
/** A run holding the lease longer than this is presumed dead and can be taken over. */
const LEASE_MINUTES = 30;
/** Per-run page cap (100 contacts/page). A larger backfill continues in the next job. */
export const DEFAULT_MAX_PAGES = 50;

export interface GhlConfig {
  orgId: string;
  token: string;
  locationId: string;
}

function envFor(base: string, orgId: string): string | undefined {
  const suffix = orgId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return process.env[`${base}_${suffix}`]?.trim() || process.env[base]?.trim() || undefined;
}

export function ghlConfigFor(orgId: string): GhlConfig | null {
  const enabled = (process.env.GHL_SYNC_ORG_IDS ?? "").split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  if (!enabled.includes(orgId)) return null;
  const token = envFor("GHL_PRIVATE_INTEGRATION_TOKEN", orgId);
  const locationId = envFor("GHL_LOCATION_ID", orgId);
  if (!token || !locationId) return null;
  return { orgId, token, locationId };
}

export function ghlConfigs(): GhlConfig[] {
  const ids = (process.env.GHL_SYNC_ORG_IDS ?? "").split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  const configs: GhlConfig[] = [];
  for (const id of ids) {
    const cfg = ghlConfigFor(id);
    if (cfg) configs.push(cfg);
    else logger.warn({ orgId: id }, "GHL sync: org listed in GHL_SYNC_ORG_IDS but token or location id is missing");
  }
  return configs;
}

export interface GhlSyncResult {
  status: "ok" | "more_pending" | "already_running";
  created: number;
  updated: number;
  skipped: number;
  pages: number;
}

export async function runGhlSync(
  cfg: GhlConfig,
  opts: { full?: boolean; maxPages?: number; fetchImpl?: typeof fetch } = {},
): Promise<GhlSyncResult> {
  const { orgId, locationId } = cfg;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;

  await db.insert(ghlSyncStateTable).values({ orgId, locationId }).onConflictDoNothing();
  const [before] = await db.select().from(ghlSyncStateTable).where(eq(ghlSyncStateTable.orgId, orgId));
  // A different sub-account, or an explicit full backfill: start from the top.
  if (opts.full || before!.locationId !== locationId) {
    await db.update(ghlSyncStateTable)
      .set({ locationId, cursorUpdatedAt: null, backfillCompletedAt: null })
      .where(eq(ghlSyncStateTable.orgId, orgId));
  }

  const leaseCutoff = new Date(Date.now() - LEASE_MINUTES * 60_000);
  const [lease] = await db.update(ghlSyncStateTable)
    .set({ runningSince: new Date() })
    .where(and(
      eq(ghlSyncStateTable.orgId, orgId),
      or(isNull(ghlSyncStateTable.runningSince), lt(ghlSyncStateTable.runningSince, leaseCutoff)),
    ))
    .returning();
  if (!lease) return { status: "already_running", created: 0, updated: 0, skipped: 0, pages: 0 };

  const updatedSince = lease.cursorUpdatedAt;
  const totals = { created: 0, updated: 0, skipped: 0 };
  let pages = 0;
  let morePending = false;

  try {
    let searchAfter: (string | number)[] | null = null;
    for (;;) {
      if (pages >= maxPages) { morePending = true; break; }
      const page = await searchContacts(
        { token: cfg.token, locationId, updatedSince, searchAfter, page: pages + 1, pageLimit: GHL_PAGE_LIMIT },
        opts.fetchImpl,
      );
      pages++;
      let cursor: Date | null = null;
      for (const gc of page.contacts) {
        const outcome = await db.transaction((tx) => syncOneContact(tx, orgId, gc));
        totals[outcome]++;
        const updated = gc.dateUpdated ? new Date(gc.dateUpdated) : null;
        if (updated && !Number.isNaN(updated.getTime()) && (!cursor || updated > cursor)) cursor = updated;
      }
      // Advance after the page is written, so a crash re-reads rather than skips.
      if (cursor) {
        await db.update(ghlSyncStateTable).set({ cursorUpdatedAt: cursor, runningSince: new Date() })
          .where(eq(ghlSyncStateTable.orgId, orgId));
      }
      if (page.contacts.length < GHL_PAGE_LIMIT) break;
      const last = page.contacts[page.contacts.length - 1]!;
      searchAfter = last.searchAfter?.length ? last.searchAfter : null;
    }

    await db.update(ghlSyncStateTable).set({
      runningSince: null,
      lastRunAt: new Date(),
      lastStatus: morePending ? "more_pending" : "ok",
      lastError: null,
      lastRunCreated: totals.created,
      lastRunUpdated: totals.updated,
      lastRunSkipped: totals.skipped,
      ...(!morePending && !lease.backfillCompletedAt ? { backfillCompletedAt: new Date() } : {}),
    }).where(eq(ghlSyncStateTable.orgId, orgId));

    logger.info({ orgId, pages, ...totals, morePending }, "GHL sync: run finished");
    return { status: morePending ? "more_pending" : "ok", ...totals, pages };
  } catch (err) {
    await db.update(ghlSyncStateTable).set({
      runningSince: null,
      lastRunAt: new Date(),
      lastStatus: "error",
      lastError: err instanceof Error ? err.message.slice(0, 500) : "Unknown error",
      lastRunCreated: totals.created,
      lastRunUpdated: totals.updated,
      lastRunSkipped: totals.skipped,
    }).where(eq(ghlSyncStateTable.orgId, orgId));
    throw err;
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
  contact.tags = [...new Set([...contact.tags, ...(gc.tags ?? []).map((t) => t.trim()).filter(Boolean)])];
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
    contactId = link.contactId;
    await fillBlanks(tx, orgId, contactId, contact, null);
    await tx.update(externalContactLinksTable).set({ externalUpdatedAt })
      .where(eq(externalContactLinksTable.id, link.id));
  } else {
    const result = await upsertContact(tx, orgId, contact, null);
    contactId = result.contactId;
    created = result.created;
    await tx.insert(externalContactLinksTable).values({
      id: randomUUID(), orgId, source: GHL_SOURCE, externalId: gc.id, contactId, externalUpdatedAt,
    }).onConflictDoNothing();
  }

  if (gc.dnd) {
    await tx.update(contactsTable).set({ optOutSms: true, optOutEmail: true })
      .where(and(eq(contactsTable.id, contactId), eq(contactsTable.orgId, orgId),
        sql`(${contactsTable.optOutSms} = false OR ${contactsTable.optOutEmail} = false)`));
  }
  return created ? "created" : "updated";
}
