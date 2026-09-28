/**
 * The ONE definition of a "lead" for dashboard / report / leaderboard counts.
 *
 * Mediflow has two things called "lead":
 *   - `contacts.status = 'lead'` — a person in the CRM who has not yet become a
 *     prospect or client. This is what agents mean by "my leads", what the
 *     Clients & Leads page counts on its "Leads" card, and what the "Your
 *     book" donut shows.
 *   - rows in the `leads` table — routing/attribution records the inbound
 *     Live Call Queue writes (source, score, queue status). Only some contacts
 *     ever get one (hand-entered and imported contacts usually don't), so
 *     counting that table made the dashboard say "0 open leads" next to a CRM
 *     showing 8.
 *
 * Headline numbers use the first. The queue workload (second) is only shown
 * where it is labelled as such ("Open queue leads" on the leaderboard).
 */
import { and, eq, isNull, type SQL } from "drizzle-orm";
import { contactsTable } from "@workspace/db";

export const LEAD_CONTACT_STATUS = "lead" as const;

/** Contacts in `orgId` that count as leads (status Lead, not deleted). */
export function leadContactsWhere(orgId: string): SQL {
  return and(
    eq(contactsTable.orgId, orgId),
    eq(contactsTable.status, LEAD_CONTACT_STATUS),
    isNull(contactsTable.deletedAt),
  )!;
}
