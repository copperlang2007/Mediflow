/**
 * The single compliance gate for messages to consumers (contacts).
 *
 * Every SMS / email job that targets a contact carries `consumer` context
 * (orgId, contactId, automated) and is re-checked HERE, at send time, inside
 * the job handler — not only when it was enqueued. That covers sequences,
 * automation rules and manual agent sends alike, and it catches an opt-out
 * that arrives between enqueue and delivery.
 *
 * SMS:
 *   - contact deleted                → block
 *   - status do_not_contact          → block (both channels)
 *   - contact.optOutSms              → block
 *   - opt_outs row for the number    → block (matched on the last 10 digits,
 *                                      so "(512) 555-0100" matches Twilio's
 *                                      "+15125550100")
 *   - automated + org requires consent + no tcpa_consent_at/source → block
 *   - automated + outside the recipient's legal texting hours → defer
 * Email:
 *   - contact deleted                → block
 *   - contact.optOutEmail            → block
 *   - opt_outs email row             → block
 *   - automated + no unsubscribe link can be built → block (CAN-SPAM requires
 *     a working opt-out in every commercial email)
 *
 * Blocks and deferrals are logged with the contact id and reason only — never
 * the phone number, email address or message body.
 */
import { and, eq, sql } from "drizzle-orm";
import { db, contactsTable, optOutsTable, orgSettingsTable } from "@workspace/db";
import { phoneMatchKey, phoneMatchKeySql } from "./phone";
import { nextContactWindowStart } from "./quietHours";
import { unsubscribeUrl } from "./unsubscribe";

export interface ConsumerContext extends Record<string, unknown> {
  orgId: string;
  contactId: string;
  /**
   * True for system-initiated outreach (sequences, automation rules). Manual
   * one-to-one messages from an agent skip the consent and texting-hours gates
   * but are still blocked by opt-outs.
   */
  automated: boolean;
}

export type BlockReason =
  | "contact_not_found"
  | "opted_out"
  | "no_tcpa_consent"
  | "no_destination"
  | "unsubscribe_unavailable";

export type SmsDecision =
  | { action: "send"; to: string }
  | { action: "defer"; until: Date }
  | { action: "block"; reason: BlockReason };

export type EmailDecision =
  | { action: "send"; to: string; unsubscribeUrl: string | null }
  | { action: "block"; reason: BlockReason };

async function loadContact(ctx: ConsumerContext) {
  const [contact] = await db
    .select({
      phone: contactsTable.phone,
      email: contactsTable.email,
      stateCode: contactsTable.stateCode,
      optOutSms: contactsTable.optOutSms,
      optOutEmail: contactsTable.optOutEmail,
      tcpaConsentAt: contactsTable.tcpaConsentAt,
      tcpaConsentSource: contactsTable.tcpaConsentSource,
      status: contactsTable.status,
      deletedAt: contactsTable.deletedAt,
    })
    .from(contactsTable)
    .where(and(eq(contactsTable.id, ctx.contactId), eq(contactsTable.orgId, ctx.orgId)))
    .limit(1);
  return contact && !contact.deletedAt ? contact : null;
}

/** True when `phone` appears in the opt-out log for this org. */
export async function isPhoneOptedOut(orgId: string, phone: string): Promise<boolean> {
  const key = phoneMatchKey(phone);
  if (!key) return false;
  const [row] = await db
    .select({ id: optOutsTable.id })
    .from(optOutsTable)
    .where(
      and(
        eq(optOutsTable.orgId, orgId),
        eq(optOutsTable.channel, "sms"),
        sql`${phoneMatchKeySql(optOutsTable.phone)} = ${key}`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

async function isEmailOptedOut(orgId: string, email: string): Promise<boolean> {
  const [row] = await db
    .select({ id: optOutsTable.id })
    .from(optOutsTable)
    .where(
      and(
        eq(optOutsTable.orgId, orgId),
        eq(optOutsTable.channel, "email"),
        sql`lower(${optOutsTable.email}) = lower(${email})`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

async function orgRequiresSmsConsent(orgId: string): Promise<boolean> {
  const [settings] = await db
    .select({ requireSmsConsent: orgSettingsTable.requireSmsConsent })
    .from(orgSettingsTable)
    .where(eq(orgSettingsTable.orgId, orgId))
    .limit(1);
  return settings?.requireSmsConsent ?? true;
}

export async function evaluateConsumerSms(ctx: ConsumerContext, now: Date = new Date()): Promise<SmsDecision> {
  const contact = await loadContact(ctx);
  if (!contact) return { action: "block", reason: "contact_not_found" };
  if (!contact.phone) return { action: "block", reason: "no_destination" };
  if (contact.status === "do_not_contact" || contact.optOutSms || (await isPhoneOptedOut(ctx.orgId, contact.phone))) {
    return { action: "block", reason: "opted_out" };
  }
  if (ctx.automated) {
    // Consent counts only as the documented pair: when AND where it was given.
    const hasConsent = Boolean(contact.tcpaConsentAt && contact.tcpaConsentSource?.trim());
    if (!hasConsent && (await orgRequiresSmsConsent(ctx.orgId))) {
      return { action: "block", reason: "no_tcpa_consent" };
    }
    const opensAt = nextContactWindowStart(contact.stateCode, now);
    if (opensAt.getTime() > now.getTime()) return { action: "defer", until: opensAt };
  }
  return { action: "send", to: contact.phone };
}

export async function evaluateConsumerEmail(ctx: ConsumerContext): Promise<EmailDecision> {
  const contact = await loadContact(ctx);
  if (!contact) return { action: "block", reason: "contact_not_found" };
  if (!contact.email) return { action: "block", reason: "no_destination" };
  if (contact.status === "do_not_contact" || contact.optOutEmail || (await isEmailOptedOut(ctx.orgId, contact.email))) {
    return { action: "block", reason: "opted_out" };
  }
  const url = unsubscribeUrl({ orgId: ctx.orgId, contactId: ctx.contactId });
  if (ctx.automated && !url) return { action: "block", reason: "unsubscribe_unavailable" };
  return { action: "send", to: contact.email, unsubscribeUrl: url };
}
