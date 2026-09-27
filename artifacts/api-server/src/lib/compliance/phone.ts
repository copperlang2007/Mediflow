/**
 * Phone matching for opt-out enforcement.
 *
 * Contacts are stored however they were typed ("(512) 555-0100",
 * "512.555.0100", "+15125550100") while Twilio reports senders in E.164. An
 * exact string comparison therefore misses most opt-outs. Every opt-out check
 * compares the last 10 digits instead — the US subscriber number — which is
 * format-independent.
 */
import { sql, type SQL, type AnyColumn } from "drizzle-orm";

/** Last 10 digits of `raw` (fewer if the number is shorter); null if none. */
export function phoneMatchKey(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length === 0) return null;
  return digits.slice(-10);
}

/** SQL expression producing the same key for a phone column. */
export function phoneMatchKeySql(column: AnyColumn): SQL<string> {
  return sql<string>`right(regexp_replace(coalesce(${column}, ''), '[^0-9]', '', 'g'), 10)`;
}
