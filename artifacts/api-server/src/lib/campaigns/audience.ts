/**
 * Campaign audience builder.
 *
 * Turns a `CampaignAudience` filter into SQL over `contacts`, counts it for
 * the live preview, and materializes it into `campaign_recipients`.
 *
 * Always applied, whatever the filter says:
 *  - same org, not soft-deleted, status is not `do_not_contact`;
 *  - the contact has an address on the channel (email / phone).
 *
 * Opt-outs are EXCLUDED UP FRONT and recorded as `skipped_opt_out`:
 *  - email: `contacts.opt_out_email`, or the address is on the org's email
 *    suppression list (`opt_outs` channel=email — covers duplicates of the
 *    same person under another contact row);
 *  - sms:   `contacts.opt_out_sms`, or the number is on the STOP list
 *    (`opt_outs` channel=sms). The STOP list is matched on phone across all
 *    orgs because every org sends from the same Twilio number, and a STOP to
 *    that number must silence it for everyone — the same rule the existing
 *    `sendSMS()` guard applies.
 *
 * Health conditions and race are never filterable here.
 */
import { sql, type SQL } from "drizzle-orm";
import type { CampaignAudience } from "@workspace/db";
import { z } from "zod";

export const CONTACT_STATUSES = [
  "lead",
  "prospect",
  "enrolled",
  "retained",
  "lost",
] as const;
export const PLAN_TYPES = ["MA", "PDP", "MAPD", "supp", "other"] as const;

export const AudienceSchema = z
  .object({
    statuses: z.array(z.enum(CONTACT_STATUSES)).max(10).optional(),
    planTypes: z.array(z.enum(PLAN_TYPES)).max(10).optional(),
    carrierIds: z.array(z.string().min(1).max(128)).max(100).optional(),
    states: z
      .array(z.string().regex(/^[A-Za-z]{2}$/))
      .max(60)
      .optional(),
    sources: z.array(z.string().min(1).max(200)).max(50).optional(),
    tags: z.array(z.string().min(1).max(100)).max(50).optional(),
    birthdayMonth: z.number().int().min(1).max(12).optional(),
  })
  .strict();

export type Channel = "email" | "sms";

function textArray(values: string[]): SQL {
  return sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;
}

/** Filter predicate (no address / opt-out logic) over alias `c`. */
export function audienceWhere(orgId: string, a: CampaignAudience): SQL {
  const parts: SQL[] = [
    sql`c.org_id = ${orgId}`,
    sql`c.deleted_at IS NULL`,
    sql`c.status <> 'do_not_contact'`,
  ];
  if (a.statuses?.length) {
    parts.push(sql`c.status::text = ANY(${textArray(a.statuses)})`);
  }
  if (a.planTypes?.length) {
    parts.push(sql`(c.current_plan_type::text = ANY(${textArray(a.planTypes)})
      OR EXISTS (SELECT 1 FROM enrollments e WHERE e.contact_id = c.id AND e.org_id = ${orgId}
        AND e.plan_type::text = ANY(${textArray(a.planTypes)})))`);
  }
  if (a.carrierIds?.length) {
    parts.push(sql`(c.current_carrier_id = ANY(${textArray(a.carrierIds)})
      OR EXISTS (SELECT 1 FROM enrollments e WHERE e.contact_id = c.id AND e.org_id = ${orgId}
        AND e.carrier_id = ANY(${textArray(a.carrierIds)})))`);
  }
  if (a.states?.length) {
    parts.push(
      sql`upper(c.state_code) = ANY(${textArray(a.states.map((s) => s.toUpperCase()))})`,
    );
  }
  if (a.sources?.length) {
    parts.push(sql`c.lead_source = ANY(${textArray(a.sources)})`);
  }
  if (a.tags?.length) {
    parts.push(sql`c.tags && ${textArray(a.tags)}`);
  }
  if (a.birthdayMonth) {
    parts.push(sql`EXTRACT(MONTH FROM c.dob) = ${a.birthdayMonth}`);
  }
  return sql.join(parts, sql` AND `);
}

export function hasAddress(channel: Channel): SQL {
  return channel === "email"
    ? sql`(c.email IS NOT NULL AND btrim(c.email) <> '')`
    : sql`(c.phone IS NOT NULL AND btrim(c.phone) <> '')`;
}

export function isOptedOut(orgId: string, channel: Channel): SQL {
  return channel === "email"
    ? sql`(c.opt_out_email = true OR EXISTS (SELECT 1 FROM opt_outs o
        WHERE o.org_id = ${orgId} AND o.channel = 'email' AND o.email IS NOT NULL
          AND lower(o.email) = lower(c.email)))`
    : sql`(c.opt_out_sms = true OR EXISTS (SELECT 1 FROM opt_outs o
        WHERE o.channel = 'sms' AND o.phone IS NOT NULL AND o.phone = c.phone))`;
}

type Executor = { execute: (q: SQL) => Promise<unknown> };

function rowsOf<T>(result: unknown): T[] {
  const r = result as { rows?: T[] } | T[];
  return Array.isArray(r) ? r : (r.rows ?? []);
}

export interface AudiencePreview {
  matched: number;
  eligible: number;
  optedOut: number;
  missingAddress: number;
}

export async function previewAudience(
  db: Executor,
  orgId: string,
  channel: Channel,
  audience: CampaignAudience,
): Promise<AudiencePreview> {
  const where = audienceWhere(orgId, audience);
  const addr = hasAddress(channel);
  const opt = isOptedOut(orgId, channel);
  const res = await db.execute(sql`
    SELECT
      count(*)::int AS matched,
      count(*) FILTER (WHERE NOT ${addr})::int AS missing_address,
      count(*) FILTER (WHERE ${addr} AND ${opt})::int AS opted_out,
      count(*) FILTER (WHERE ${addr} AND NOT ${opt})::int AS eligible
    FROM contacts c
    WHERE ${where}
  `);
  const row = rowsOf<Record<string, number | string>>(res)[0] ?? {};
  return {
    matched: Number(row.matched ?? 0),
    eligible: Number(row.eligible ?? 0),
    optedOut: Number(row.opted_out ?? 0),
    missingAddress: Number(row.missing_address ?? 0),
  };
}

/**
 * Snapshot the audience into `campaign_recipients`. Idempotent: the unique
 * (campaign_id, contact_id) key makes a second call (job retry, re-enqueue)
 * insert nothing new for contacts already present.
 */
export async function materializeRecipients(
  db: Executor,
  campaign: { id: string; orgId: string; channel: Channel; audience: CampaignAudience },
): Promise<void> {
  const { id, orgId, channel } = campaign;
  const where = audienceWhere(orgId, campaign.audience ?? {});
  const addr = hasAddress(channel);
  const opt = isOptedOut(orgId, channel);
  const addressCol = channel === "email" ? sql`btrim(c.email)` : sql`btrim(c.phone)`;
  await db.execute(sql`
    INSERT INTO campaign_recipients
      (id, org_id, campaign_id, contact_id, channel, to_address, status, error)
    SELECT
      gen_random_uuid()::text, ${orgId}, ${id}, c.id, ${channel}::channel, ${addressCol},
      (CASE WHEN ${opt} THEN 'skipped_opt_out' ELSE 'queued' END)::campaign_recipient_status,
      CASE WHEN ${opt} THEN 'Opted out before send' ELSE NULL END
    FROM contacts c
    WHERE ${where} AND ${addr}
    ON CONFLICT (campaign_id, contact_id) DO NOTHING
  `);
}
