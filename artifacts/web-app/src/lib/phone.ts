/**
 * Display-only phone formatting.
 *
 * Stored values stay in E.164 ("+15555550029") and links keep using the raw
 * value (`tel:+15555550029`); this only changes what people read.
 *
 *   "+15555550029"   → "(555) 555-0029"
 *   "5555550029"     → "(555) 555-0029"
 *   "+442079460000"  → "+442079460000"   (non-US numbers are left as stored)
 */
export function formatPhone(raw: string | null | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  // An explicit non-US country code: show it exactly as stored.
  if (trimmed.startsWith("+") && !trimmed.startsWith("+1")) return trimmed;
  const d = trimmed.replace(/\D/g, "");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  if (ten.length === 10) return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
  return trimmed;
}
