/**
 * Dialable number normalisation for outbound calling.
 *
 * Fail closed: only a valid North American (NANP) number becomes dialable.
 * Anything else — international, too short/long, a caller-ID display name —
 * yields null and the call is blocked as INVALID_NUMBER. Medicare
 * beneficiaries are US residents, so an international dial is never expected.
 */
const NANP = /^\+1([2-9]\d{2})([2-9]\d{6})$/;

/** `+1XXXXXXXXXX` for a valid NANP number in any common format, else null. */
export function toDialableE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  let national: string;
  if (digits.length === 10) national = digits;
  else if (digits.length === 11 && digits.startsWith("1")) national = digits.slice(1);
  else return null;
  const e164 = `+1${national}`;
  const m = NANP.exec(e164);
  if (!m) return null;
  const area = m[1]!;
  // N11 service codes and premium-rate 900 are never valid destinations.
  if (area.endsWith("11") || area === "900") return null;
  return e164;
}
