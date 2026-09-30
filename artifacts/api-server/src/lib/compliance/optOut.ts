/**
 * Shared helpers for recording a phone opt-out (do-not-contact request) and for
 * checking a number against the opt-out log across ALL orgs.
 *
 * Mirrors what the inbound STOP keyword does in routes/webhooks.ts: one
 * `opt_outs` row per (org, phone, channel) — the unique index makes it
 * idempotent — and the contact's `opt_out_sms` flag. The `opt_outs.channel`
 * enum has no voice value, so a phone opt-out is stored on `sms`: the number
 * list is channel-agnostic in practice (preclearance matches any channel, and
 * the SMS gate matches by number), so it stops both calls and texts.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { db as defaultDb, contactsTable, optOutsTable } from "@workspace/db";
import { phoneMatchKey, phoneMatchKeySql } from "./phone";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = PgDatabase<any, any, any>;

/**
 * True when the number is in the opt-out log for ANY org, on any channel,
 * matched on the last 10 digits. A consumer who told one agency to stop has
 * told the number's every caller — the safe reading for TCPA/DNC.
 */
export async function isNumberOptedOutAnyOrg(
  phone: string,
  handle: AnyDb = defaultDb,
): Promise<boolean> {
  const key = phoneMatchKey(phone);
  if (!key) return false;
  const [row] = await handle
    .select({ id: optOutsTable.id })
    .from(optOutsTable)
    .where(sql`${phoneMatchKeySql(optOutsTable.phone)} = ${key}`)
    .limit(1);
  return Boolean(row);
}

/**
 * Record an EMAIL do-not-contact request for a contact. Idempotent: one
 * `opt_outs` row per (org, email) on the email channel, and the contact's
 * `opt_out_email` flag. Returns whether the email was already on the list.
 * (A phone opt-out does not stop email; this is the email path.)
 */
export async function recordEmailOptOut(
  handle: AnyDb,
  opts: { orgId: string; contactId: string; email: string; source: string },
): Promise<{ alreadyOnList: boolean }> {
  const [existing] = await handle
    .select({ id: optOutsTable.id })
    .from(optOutsTable)
    .where(
      and(
        eq(optOutsTable.orgId, opts.orgId),
        eq(optOutsTable.channel, "email"),
        sql`lower(${optOutsTable.email}) = lower(${opts.email})`,
      ),
    )
    .limit(1);
  if (!existing) {
    await handle
      .insert(optOutsTable)
      .values({ id: randomUUID(), orgId: opts.orgId, email: opts.email, channel: "email", source: opts.source });
  }
  await handle
    .update(contactsTable)
    .set({ optOutEmail: true })
    .where(and(eq(contactsTable.id, opts.contactId), eq(contactsTable.orgId, opts.orgId)));
  return { alreadyOnList: Boolean(existing) };
}

/** Record a do-not-contact request for `phone` in `orgId`. Idempotent. */
export async function recordPhoneOptOut(
  handle: AnyDb,
  opts: { orgId: string; contactId: string | null; phone: string; source: string },
): Promise<void> {
  await handle
    .insert(optOutsTable)
    .values({ id: randomUUID(), orgId: opts.orgId, phone: opts.phone, channel: "sms", source: opts.source })
    .onConflictDoNothing({ target: [optOutsTable.orgId, optOutsTable.phone, optOutsTable.channel] });
  if (opts.contactId) {
    await handle
      .update(contactsTable)
      .set({ optOutSms: true })
      .where(and(eq(contactsTable.id, opts.contactId), eq(contactsTable.orgId, opts.orgId)));
  }
}
