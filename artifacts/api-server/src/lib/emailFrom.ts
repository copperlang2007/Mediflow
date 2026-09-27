/**
 * From-header helper for white-label agency email (org branding
 * `email_from_name`). Kept out of lib/email.ts so modules and tests that mock
 * the email sender keep working.
 */
/** `"Name <addr>"` using the configured sender address, or undefined for the default. */
export function fromHeaderFor(fromName: string | undefined): string | undefined {
  const clean = fromName?.replace(/[<>"\\\r\n]/g, "").trim();
  if (!clean) return undefined;
  const configured = process.env.EMAIL_FROM_ADDRESS ?? "noreply@mediflow.app";
  const address = configured.match(/<([^>]+)>/)?.[1] ?? configured;
  return `${clean} <${address}>`;
}
