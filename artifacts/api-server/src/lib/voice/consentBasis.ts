/**
 * Which consent rule (if any) lets a voice call to a contact go ahead.
 *
 *   'documented'                 the contact has tcpa_consent_at AND a source.
 *   'imported_ghl_recorded_call' the ORG has switched on
 *                                `allow_imported_contact_consent`, the contact
 *                                is linked to a GoHighLevel contact, and nothing
 *                                anywhere says do-not-contact. The owner states
 *                                consent for these clients is recorded on the
 *                                call recordings; Mediflow has NOT verified that.
 *
 * LEGAL CAVEAT (keep visible): "no do-not-disturb flag" is NOT the same as
 * consent. The national and state do-not-call registries are NOT checked here.
 * Existing-customer rules have time limits. Counsel should confirm this basis.
 * Nothing in this module claims the call is compliant.
 *
 * The imported basis fails closed: anything unexpected (no setting row, no
 * link, a flag of any kind, an opt-out for the number in ANY org) is `null`.
 */
import { and, eq } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { db as defaultDb, externalContactLinksTable, orgSettingsTable } from "@workspace/db";
import { isNumberOptedOutAnyOrg } from "../compliance/optOut";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = PgDatabase<any, any, any>;

export type ConsentBasis = "documented" | "imported_ghl_recorded_call";
export const IMPORTED_CONSENT_BASIS: ConsentBasis = "imported_ghl_recorded_call";

/** Same string the GHL sync writes to external_contact_links.source. */
const GHL_LINK_SOURCE = "gohighlevel";

export interface ConsentContactFacts {
  id: string;
  status: string;
  tcpaConsentAt: Date | null;
  tcpaConsentSource: string | null;
  optOutSms: boolean;
  optOutEmail: boolean;
}

export function hasDocumentedConsent(c: Pick<ConsentContactFacts, "tcpaConsentAt" | "tcpaConsentSource">): boolean {
  return Boolean(c.tcpaConsentAt && c.tcpaConsentSource?.trim());
}

export async function resolveConsentBasis(
  orgId: string,
  contact: ConsentContactFacts,
  /** The number being dialed (checked against opt-outs in every org). */
  dialedPhone: string | null,
  handle: AnyDb = defaultDb,
): Promise<ConsentBasis | null> {
  if (hasDocumentedConsent(contact)) return "documented";

  // Every condition below must hold; the first miss ends it.
  if (contact.status === "do_not_contact" || contact.optOutSms || contact.optOutEmail) return null;

  const [settings] = await handle
    .select({ on: orgSettingsTable.allowImportedContactConsent })
    .from(orgSettingsTable)
    .where(eq(orgSettingsTable.orgId, orgId))
    .limit(1);
  if (settings?.on !== true) return null;

  const links = await handle
    .select({ externalDnd: externalContactLinksTable.externalDnd })
    .from(externalContactLinksTable)
    .where(
      and(
        eq(externalContactLinksTable.orgId, orgId),
        eq(externalContactLinksTable.source, GHL_LINK_SOURCE),
        eq(externalContactLinksTable.contactId, contact.id),
      ),
    );
  // Linked to GHL, and every linked record has been checked and GHL said
  // do-not-disturb is OFF. Only an explicit false passes: null (unknown, never
  // refreshed - e.g. a legacy link) and true both block. This also covers a DND
  // the sync could not apply to a weakly matched contact.
  if (links.length === 0 || links.some((l) => l.externalDnd !== false)) return null;

  if (!dialedPhone || (await isNumberOptedOutAnyOrg(dialedPhone, handle))) return null;

  return IMPORTED_CONSENT_BASIS;
}
