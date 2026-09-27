/**
 * Campaign content rendering: merge fields, the CAN-SPAM email footer and
 * `List-Unsubscribe` headers, and the TCPA "Reply STOP" line for SMS.
 *
 * Merge fields use the same `{{name}}` syntax as the existing template
 * preview (`POST /templates/preview`). Values are HTML-escaped when rendered
 * into email HTML. Unknown tokens render as empty so a typo never ships raw
 * braces to a client. Health conditions / race are never merge fields.
 */

export interface MergeContext {
  first_name: string;
  last_name: string;
  agency_name: string;
  agent_name: string;
  plan_type: string;
  carrier: string;
  plan_year: string;
}

export const MERGE_FIELDS: Array<{ token: string; label: string }> = [
  { token: "{{first_name}}", label: "First name" },
  { token: "{{last_name}}", label: "Last name" },
  { token: "{{agency_name}}", label: "Agency name" },
  { token: "{{agent_name}}", label: "Assigned agent" },
  { token: "{{plan_type}}", label: "Plan type" },
  { token: "{{carrier}}", label: "Carrier" },
  { token: "{{plan_year}}", label: "Plan year" },
];

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function applyMergeFields(
  template: string,
  ctx: MergeContext,
  opts: { html: boolean },
): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_m, key: string) => {
    const v = (ctx as unknown as Record<string, string | undefined>)[key] ?? "";
    return opts.html ? escapeHtml(v) : v;
  });
}

export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface SenderIdentity {
  agencyName: string;
  physicalAddress: string;
}

export function emailFooterHtml(sender: SenderIdentity, unsubscribeHref: string): string {
  return `
<div style="margin-top:32px;padding-top:16px;border-top:1px solid #e2e8f0;color:#64748b;font-size:12px;line-height:1.6;font-family:system-ui,sans-serif">
  <p style="margin:0">You are receiving this email from ${escapeHtml(sender.agencyName)}.</p>
  <p style="margin:0">${escapeHtml(sender.physicalAddress).replace(/\n/g, "<br>")}</p>
  <p style="margin:8px 0 0"><a href="${escapeHtml(unsubscribeHref)}" style="color:#64748b">Unsubscribe</a> from marketing email.</p>
</div>`.trim();
}

export function emailFooterText(sender: SenderIdentity, unsubscribeHref: string): string {
  return `\n\n--\nYou are receiving this email from ${sender.agencyName}.\n${sender.physicalAddress}\nUnsubscribe: ${unsubscribeHref}`;
}

export function wrapEmailHtml(bodyHtml: string, footerHtml: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px;background:#f8fafc">
<div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:28px 32px">
${bodyHtml}
${footerHtml}
</div>
</body></html>`;
}

export const STOP_LINE = "Reply STOP to opt out.";

/** Append the opt-out line unless the body already carries one. */
export function withStopLine(body: string): string {
  if (/reply\s+stop/i.test(body)) return body;
  return `${body.trimEnd()}\n${STOP_LINE}`;
}

/** GSM-7 segments are 160 chars (153 when concatenated); UCS-2 is 70/67. */
export function smsSegments(body: string): number {
  if (!body) return 0;
  // eslint-disable-next-line no-control-regex
  const gsm = /^[\x0A\x0D\x20-\x7E£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¤¡ÄÖÑÜ§¿äöñüà€^{}\\[~\]|]*$/.test(body);
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  return body.length <= single ? 1 : Math.ceil(body.length / multi);
}
