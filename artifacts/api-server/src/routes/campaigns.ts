/**
 * Omnichannel campaigns (email + SMS) — authenticated API.
 *
 *   GET    /campaigns?channel=                 list
 *   GET    /campaigns/overview?channel=        KPI totals (real recipient data)
 *   GET    /campaigns/config                   what is / isn't set up
 *   GET    /campaigns/activity?channel=        recent delivery / open / click events
 *   PUT    /campaigns/settings                 sender name, mailing address, time zone
 *   POST   /campaigns/audience/preview         live recipient count for a filter
 *   GET    /campaigns/opt-outs?channel=        unsubscribes / STOP list
 *   POST   /campaigns/opt-outs/:channel/resubscribe   email only, confirmed + audited
 *   POST   /campaigns                          create draft
 *   GET    /campaigns/:id                      detail + recipients
 *   PATCH  /campaigns/:id                      edit draft
 *   DELETE /campaigns/:id                      delete draft / cancelled
 *   POST   /campaigns/:id/send                 send now or schedule
 *   POST   /campaigns/:id/cancel               cancel scheduled / sending
 *
 * Permissions reuse the existing `communication` resource:
 *   read   → view (super_admin, agency_admin, compliance_manager, agent_support, developer)
 *   create → build drafts (super_admin, agency_admin, agent_support)
 *   update → SEND, schedule, cancel, delete, sender settings and email re-opt-in
 *            (super_admin, agency_admin only) — a marketing blast is an owner
 *            decision, stricter than the one-to-one reply route.
 * Every query is scoped to the caller's org.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "crypto";
import {
  db,
  auditLogTable,
  campaignRecipientsTable,
  campaignSettingsTable,
  campaignsTable,
  contactsTable,
  emailTemplatesTable,
  optOutsTable,
  smsTemplatesTable,
  type CampaignAudience,
} from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { enqueue, JOB_NAMES } from "../lib/jobs";
import { logger } from "../lib/logger";
import { isEmailConfigured } from "../lib/email";
import { isConfigured as isSmsConfigured } from "../lib/sms";
import { AudienceSchema, previewAudience } from "../lib/campaigns/audience";
import { loadSenderSettings, senderIdentity } from "../lib/campaigns/service";
import { publicBaseUrl, unsubscribeSecret } from "../lib/campaigns/unsubscribeToken";
import { resendWebhookSecret } from "../lib/campaigns/svix";
import { isValidTimeZone } from "../lib/campaigns/quietHours";
import { MERGE_FIELDS, smsSegments } from "../lib/campaigns/render";

const router: IRouter = Router();

const ChannelSchema = z.enum(["email", "sms"]);

function param(req: Request, key: string): string {
  const v = req.params[key];
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

function channelQuery(req: Request): "email" | "sms" | null {
  const raw = req.query.channel;
  if (raw === undefined) return null;
  const parsed = ChannelSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

async function audit(
  authReq: AuthenticatedRequest,
  action: string,
  resourceType: string,
  resourceId: string | null,
  changes: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(auditLogTable).values({
      id: randomUUID(),
      orgId: authReq.orgId,
      userId: authReq.userId,
      userRole: authReq.userRole,
      action,
      resourceType,
      resourceId,
      changes,
    });
  } catch (err) {
    logger.error({ err, action, resourceType }, "Failed to write campaign audit entry");
  }
}

/** Config state the UI uses to decide between real numbers and setup notes. */
async function configState(orgId: string) {
  const settings = await loadSenderSettings(orgId);
  const base = publicBaseUrl();
  return {
    email: {
      sendingConfigured: isEmailConfigured(),
      unsubscribeConfigured: Boolean(unsubscribeSecret() && base),
      senderAddressConfigured: Boolean(senderIdentity(settings)),
      trackingConfigured: Boolean(resendWebhookSecret()),
      webhookPath: "/api/campaigns/v1/webhooks/resend",
    },
    sms: {
      sendingConfigured: isSmsConfigured(),
      trackingConfigured: Boolean(
        process.env.TWILIO_AUTH_TOKEN && (process.env.TWILIO_WEBHOOK_PUBLIC_HOST?.trim() || base),
      ),
      webhookPath: "/api/campaigns/v1/webhooks/twilio-status",
    },
    settings: {
      senderName: settings.agencyName,
      physicalAddress: settings.physicalAddress,
      replyToEmail: settings.replyToEmail,
      defaultTimeZone: settings.defaultTimeZone,
    },
    mergeFields: MERGE_FIELDS,
  };
}

// ---- Static paths first (before /campaigns/:id) -----------------------------

router.get(
  "/campaigns/config",
  requireAuth,
  requirePermission("communication", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    res.json(await configState(authReq.orgId));
  },
);

const SettingsSchema = z
  .object({
    senderName: z.string().trim().min(1).max(120).nullable().optional(),
    physicalAddress: z.string().trim().min(10).max(400).nullable().optional(),
    replyToEmail: z.string().trim().email().max(254).nullable().optional(),
    defaultTimeZone: z.string().trim().min(3).max(64).optional(),
  })
  .strict();

router.put(
  "/campaigns/settings",
  requireAuth,
  requirePermission("communication", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = SettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }
    const d = parsed.data;
    if (d.defaultTimeZone && !isValidTimeZone(d.defaultTimeZone)) {
      res.status(400).json({ error: "Unknown time zone" });
      return;
    }
    const values = {
      ...(d.senderName !== undefined ? { senderName: d.senderName } : {}),
      ...(d.physicalAddress !== undefined ? { physicalAddress: d.physicalAddress } : {}),
      ...(d.replyToEmail !== undefined ? { replyToEmail: d.replyToEmail } : {}),
      ...(d.defaultTimeZone !== undefined ? { defaultTimeZone: d.defaultTimeZone } : {}),
      updatedBy: authReq.userId,
      updatedAt: new Date(),
    };
    await db
      .insert(campaignSettingsTable)
      .values({ orgId: authReq.orgId, ...values })
      .onConflictDoUpdate({ target: campaignSettingsTable.orgId, set: values });
    await audit(authReq, "update", "campaign_settings", authReq.orgId, d);
    res.json(await configState(authReq.orgId));
  },
);

router.get(
  "/campaigns/overview",
  requireAuth,
  requirePermission("communication", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const channel = channelQuery(req) ?? "email";
    const r = campaignRecipientsTable;
    const [row] = await db
      .select({
        sent: sql<number>`count(*) FILTER (WHERE ${r.sentAt} IS NOT NULL)::int`,
        delivered: sql<number>`count(*) FILTER (WHERE ${r.deliveredAt} IS NOT NULL)::int`,
        opened: sql<number>`count(*) FILTER (WHERE ${r.openedAt} IS NOT NULL)::int`,
        clicked: sql<number>`count(*) FILTER (WHERE ${r.clickedAt} IS NOT NULL)::int`,
        bounced: sql<number>`count(*) FILTER (WHERE ${r.status} = 'bounced')::int`,
        failed: sql<number>`count(*) FILTER (WHERE ${r.status} = 'failed')::int`,
        skipped: sql<number>`count(*) FILTER (WHERE ${r.status} = 'skipped_opt_out')::int`,
        unsubscribed: sql<number>`count(*) FILTER (WHERE ${r.unsubscribedAt} IS NOT NULL)::int`,
      })
      .from(r)
      .where(and(eq(r.orgId, authReq.orgId), eq(r.channel, channel)));

    const optOutCol = channel === "email" ? contactsTable.optOutEmail : contactsTable.optOutSms;
    const [opt] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(contactsTable)
      .where(and(eq(contactsTable.orgId, authReq.orgId), eq(optOutCol, true)));

    const [camp] = await db
      .select({
        total: sql<number>`count(*)::int`,
        sentCampaigns: sql<number>`count(*) FILTER (WHERE ${campaignsTable.status} = 'sent')::int`,
      })
      .from(campaignsTable)
      .where(and(eq(campaignsTable.orgId, authReq.orgId), eq(campaignsTable.channel, channel)));

    const cfg = await configState(authReq.orgId);
    const trackingConnected = channel === "email" ? cfg.email.trackingConfigured : cfg.sms.trackingConfigured;
    const sent = Number(row?.sent ?? 0);
    const pct = (n: number): number | null =>
      trackingConnected && sent > 0 ? Math.round((n / sent) * 1000) / 10 : null;
    res.json({
      channel,
      campaigns: Number(camp?.total ?? 0),
      sentCampaigns: Number(camp?.sentCampaigns ?? 0),
      sent,
      delivered: Number(row?.delivered ?? 0),
      opened: Number(row?.opened ?? 0),
      clicked: Number(row?.clicked ?? 0),
      bounced: Number(row?.bounced ?? 0),
      failed: Number(row?.failed ?? 0),
      skippedOptOut: Number(row?.skipped ?? 0),
      unsubscribed: Number(row?.unsubscribed ?? 0),
      optedOutContacts: Number(opt?.n ?? 0),
      trackingConnected,
      deliveryRate: pct(Number(row?.delivered ?? 0)),
      openRate: channel === "email" ? pct(Number(row?.opened ?? 0)) : null,
      clickRate: channel === "email" ? pct(Number(row?.clicked ?? 0)) : null,
    });
  },
);

router.get(
  "/campaigns/activity",
  requireAuth,
  requirePermission("communication", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const channel = channelQuery(req) ?? "email";
    const r = campaignRecipientsTable;
    const rows = await db
      .select({
        recipientId: r.id,
        campaignId: r.campaignId,
        campaignName: campaignsTable.name,
        contactId: r.contactId,
        firstName: contactsTable.firstName,
        lastName: contactsTable.lastName,
        status: r.status,
        sentAt: r.sentAt,
        deliveredAt: r.deliveredAt,
        openedAt: r.openedAt,
        clickedAt: r.clickedAt,
        bouncedAt: r.bouncedAt,
        unsubscribedAt: r.unsubscribedAt,
      })
      .from(r)
      .innerJoin(campaignsTable, eq(campaignsTable.id, r.campaignId))
      .innerJoin(contactsTable, eq(contactsTable.id, r.contactId))
      .where(
        and(
          eq(r.orgId, authReq.orgId),
          eq(r.channel, channel),
          or(isNotNull(r.deliveredAt), isNotNull(r.openedAt), isNotNull(r.clickedAt), isNotNull(r.bouncedAt), isNotNull(r.unsubscribedAt)),
        ),
      )
      .orderBy(desc(r.updatedAt))
      .limit(50);
    res.json(rows);
  },
);

const PreviewSchema = z.object({ channel: ChannelSchema, audience: AudienceSchema.default({}) });

router.post(
  "/campaigns/audience/preview",
  requireAuth,
  requirePermission("communication", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = PreviewSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }
    res.json(await previewAudience(db, authReq.orgId, parsed.data.channel, parsed.data.audience));
  },
);

router.get(
  "/campaigns/audience/options",
  requireAuth,
  requirePermission("communication", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const base = and(eq(contactsTable.orgId, authReq.orgId), sql`${contactsTable.deletedAt} IS NULL`);
    const states = await db
      .selectDistinct({ v: sql<string>`upper(${contactsTable.stateCode})` })
      .from(contactsTable)
      .where(and(base, isNotNull(contactsTable.stateCode)));
    const sources = await db
      .selectDistinct({ v: contactsTable.leadSource })
      .from(contactsTable)
      .where(and(base, isNotNull(contactsTable.leadSource)));
    const tagRows = await db
      .selectDistinct({ v: sql<string>`unnest(${contactsTable.tags})` })
      .from(contactsTable)
      .where(base);
    const carriers = await db.execute(sql`
      SELECT id, name FROM carriers WHERE org_id = ${authReq.orgId} AND is_active = true ORDER BY name LIMIT 200
    `);
    const carrierRows = (Array.isArray(carriers) ? carriers : (carriers as { rows: unknown[] }).rows) as Array<{ id: string; name: string }>;
    const clean = (xs: Array<{ v: string | null }>): string[] =>
      xs.map((x) => x.v).filter((v): v is string => !!v && v.trim().length > 0).sort().slice(0, 200);
    res.json({
      states: clean(states),
      sources: clean(sources),
      tags: clean(tagRows),
      carriers: carrierRows.map((c) => ({ id: c.id, name: c.name })),
    });
  },
);

router.get(
  "/campaigns/opt-outs",
  requireAuth,
  requirePermission("communication", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const channel = channelQuery(req) ?? "email";
    const flag = channel === "email" ? contactsTable.optOutEmail : contactsTable.optOutSms;

    const contacts = await db
      .select({
        contactId: contactsTable.id,
        firstName: contactsTable.firstName,
        lastName: contactsTable.lastName,
        email: contactsTable.email,
        phone: contactsTable.phone,
        updatedAt: contactsTable.updatedAt,
      })
      .from(contactsTable)
      .where(and(eq(contactsTable.orgId, authReq.orgId), eq(flag, true), sql`${contactsTable.deletedAt} IS NULL`))
      .orderBy(desc(contactsTable.updatedAt))
      .limit(500);

    const list = await db
      .select()
      .from(optOutsTable)
      .where(and(eq(optOutsTable.orgId, authReq.orgId), eq(optOutsTable.channel, channel)))
      .orderBy(desc(optOutsTable.optedOutAt))
      .limit(500);

    const byAddress = new Map<string, (typeof list)[number]>();
    for (const o of list) {
      const key = (channel === "email" ? o.email?.toLowerCase() : o.phone) ?? "";
      if (key && !byAddress.has(key)) byAddress.set(key, o);
    }

    const seen = new Set<string>();
    const out: Array<{
      contactId: string | null;
      name: string | null;
      address: string | null;
      optedOutAt: string | null;
      source: string;
    }> = [];
    for (const c of contacts) {
      const addr = channel === "email" ? c.email : c.phone;
      const key = (channel === "email" ? addr?.toLowerCase() : addr) ?? "";
      const entry = key ? byAddress.get(key) : undefined;
      if (key) seen.add(key);
      out.push({
        contactId: c.contactId,
        name: `${c.firstName} ${c.lastName}`.trim(),
        address: addr ?? null,
        optedOutAt: (entry?.optedOutAt ?? c.updatedAt)?.toISOString() ?? null,
        source: entry ? (channel === "sms" ? "Replied STOP" : "Unsubscribe link or complaint") : "Marked on contact record",
      });
    }
    for (const [key, o] of byAddress) {
      if (seen.has(key)) continue;
      out.push({
        contactId: null,
        name: null,
        address: channel === "email" ? o.email : o.phone,
        optedOutAt: o.optedOutAt.toISOString(),
        source: channel === "sms" ? "Replied STOP" : "Suppression list",
      });
    }
    out.sort((a, b) => (b.optedOutAt ?? "").localeCompare(a.optedOutAt ?? ""));
    res.json({ channel, total: out.length, items: out });
  },
);

const ResubscribeSchema = z.object({
  contactId: z.string().min(1).max(128),
  confirm: z.literal(true),
  reason: z.string().trim().min(5).max(500),
});

router.post(
  "/campaigns/opt-outs/:channel/resubscribe",
  requireAuth,
  requirePermission("communication", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const channel = param(req, "channel");
    if (channel === "sms") {
      // TCPA: an SMS opt-in after STOP must come from the consumer texting
      // START to our number (handled by the Twilio inbound webhook). Staff
      // can never re-enable SMS from the UI.
      res.status(403).json({
        error: "SMS opt-outs can only be reversed by the client texting START to your number.",
      });
      return;
    }
    if (channel !== "email") {
      res.status(404).json({ error: "Unknown channel" });
      return;
    }
    const parsed = ResubscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Re-subscribing needs an explicit confirmation and a reason (e.g. the client asked in writing).",
        details: parsed.error.issues,
      });
      return;
    }
    const [contact] = await db
      .select({ id: contactsTable.id, email: contactsTable.email, optOutEmail: contactsTable.optOutEmail })
      .from(contactsTable)
      .where(and(eq(contactsTable.id, parsed.data.contactId), eq(contactsTable.orgId, authReq.orgId)))
      .limit(1);
    if (!contact) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }
    await db.transaction(async (tx) => {
      await tx
        .update(contactsTable)
        .set({ optOutEmail: false })
        .where(and(eq(contactsTable.id, contact.id), eq(contactsTable.orgId, authReq.orgId)));
      if (contact.email) {
        await tx
          .delete(optOutsTable)
          .where(
            and(
              eq(optOutsTable.orgId, authReq.orgId),
              eq(optOutsTable.channel, "email"),
              sql`lower(${optOutsTable.email}) = lower(${contact.email})`,
            ),
          );
      }
      await tx.insert(auditLogTable).values({
        id: randomUUID(),
        orgId: authReq.orgId,
        userId: authReq.userId,
        userRole: authReq.userRole,
        action: "email_resubscribe",
        resourceType: "contact",
        resourceId: contact.id,
        changes: {
          optOutEmail: { from: contact.optOutEmail, to: false },
          reason: parsed.data.reason,
          confirmed: true,
        },
      });
    });
    res.json({ success: true, contactId: contact.id });
  },
);

// ---- Collection + item routes -----------------------------------------------

function serialize(c: typeof campaignsTable.$inferSelect, templateName?: string | null) {
  return {
    ...c,
    templateName: templateName ?? null,
    segments: c.channel === "sms" ? smsSegments(c.body ?? "") : null,
  };
}

router.get(
  "/campaigns",
  requireAuth,
  requirePermission("communication", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const channel = channelQuery(req);
    const conds = [eq(campaignsTable.orgId, authReq.orgId)];
    if (channel) conds.push(eq(campaignsTable.channel, channel));
    const rows = await db
      .select({
        campaign: campaignsTable,
        emailTemplateName: emailTemplatesTable.name,
        smsTemplateName: smsTemplatesTable.name,
      })
      .from(campaignsTable)
      .leftJoin(emailTemplatesTable, eq(emailTemplatesTable.id, campaignsTable.emailTemplateId))
      .leftJoin(smsTemplatesTable, eq(smsTemplatesTable.id, campaignsTable.smsTemplateId))
      .where(and(...conds))
      .orderBy(desc(campaignsTable.createdAt))
      .limit(200);
    res.json(rows.map((r) => serialize(r.campaign, r.emailTemplateName ?? r.smsTemplateName)));
  },
);

const CampaignBodySchema = z
  .object({
    channel: ChannelSchema,
    name: z.string().trim().min(1).max(200),
    templateId: z.string().min(1).max(128).nullable().optional(),
    subject: z.string().max(300).nullable().optional(),
    body: z.string().max(100_000).nullable().optional(),
    audience: AudienceSchema.default({}),
  })
  .strict();

async function resolveTemplate(
  orgId: string,
  channel: "email" | "sms",
  templateId: string | null | undefined,
): Promise<{ ok: true } | { ok: false }> {
  if (!templateId) return { ok: true };
  const table = channel === "email" ? emailTemplatesTable : smsTemplatesTable;
  const [t] = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, templateId), eq(table.orgId, orgId)))
    .limit(1);
  return t ? { ok: true } : { ok: false };
}

router.post(
  "/campaigns",
  requireAuth,
  requirePermission("communication", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = CampaignBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }
    const d = parsed.data;
    if (d.channel === "sms" && (d.body?.length ?? 0) > 1600) {
      res.status(400).json({ error: "SMS body is limited to 1600 characters" });
      return;
    }
    if (!(await resolveTemplate(authReq.orgId, d.channel, d.templateId)).ok) {
      res.status(400).json({ error: "Template not found" });
      return;
    }
    const [row] = await db
      .insert(campaignsTable)
      .values({
        id: randomUUID(),
        orgId: authReq.orgId,
        channel: d.channel,
        name: d.name,
        emailTemplateId: d.channel === "email" ? (d.templateId ?? null) : null,
        smsTemplateId: d.channel === "sms" ? (d.templateId ?? null) : null,
        subject: d.channel === "email" ? (d.subject ?? null) : null,
        body: d.body ?? null,
        audience: d.audience as CampaignAudience,
        status: "draft",
        createdBy: authReq.userId,
      })
      .returning();
    await audit(authReq, "create", "campaign", row!.id, { name: d.name, channel: d.channel });
    res.status(201).json(serialize(row!));
  },
);

async function loadCampaign(orgId: string, id: string) {
  const [row] = await db
    .select()
    .from(campaignsTable)
    .where(and(eq(campaignsTable.id, id), eq(campaignsTable.orgId, orgId)))
    .limit(1);
  return row ?? null;
}

router.get(
  "/campaigns/:id",
  requireAuth,
  requirePermission("communication", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const c = await loadCampaign(authReq.orgId, param(req, "id"));
    if (!c) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
    const recipients = await db
      .select({
        id: campaignRecipientsTable.id,
        contactId: campaignRecipientsTable.contactId,
        firstName: contactsTable.firstName,
        lastName: contactsTable.lastName,
        status: campaignRecipientsTable.status,
        sentAt: campaignRecipientsTable.sentAt,
        deliveredAt: campaignRecipientsTable.deliveredAt,
        openedAt: campaignRecipientsTable.openedAt,
        clickedAt: campaignRecipientsTable.clickedAt,
        unsubscribedAt: campaignRecipientsTable.unsubscribedAt,
        error: campaignRecipientsTable.error,
      })
      .from(campaignRecipientsTable)
      .innerJoin(contactsTable, eq(contactsTable.id, campaignRecipientsTable.contactId))
      .where(and(eq(campaignRecipientsTable.campaignId, c.id), eq(campaignRecipientsTable.orgId, authReq.orgId)))
      .orderBy(desc(campaignRecipientsTable.updatedAt))
      .limit(200);
    let templateName: string | null = null;
    if (c.emailTemplateId || c.smsTemplateId) {
      const table = c.channel === "email" ? emailTemplatesTable : smsTemplatesTable;
      const tid = (c.channel === "email" ? c.emailTemplateId : c.smsTemplateId) ?? "";
      const [t] = await db
        .select({ name: table.name })
        .from(table)
        .where(and(eq(table.id, tid), eq(table.orgId, authReq.orgId)))
        .limit(1);
      templateName = t?.name ?? null;
    }
    res.json({ ...serialize(c, templateName), recipients });
  },
);

router.patch(
  "/campaigns/:id",
  requireAuth,
  requirePermission("communication", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const c = await loadCampaign(authReq.orgId, param(req, "id"));
    if (!c) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
    if (c.status !== "draft") {
      res.status(409).json({ error: "Only draft campaigns can be edited" });
      return;
    }
    const parsed = CampaignBodySchema.omit({ channel: true }).partial().strict().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }
    const d = parsed.data;
    if (c.channel === "sms" && (d.body?.length ?? 0) > 1600) {
      res.status(400).json({ error: "SMS body is limited to 1600 characters" });
      return;
    }
    if (d.templateId !== undefined && !(await resolveTemplate(authReq.orgId, c.channel, d.templateId)).ok) {
      res.status(400).json({ error: "Template not found" });
      return;
    }
    const [row] = await db
      .update(campaignsTable)
      .set({
        ...(d.name !== undefined ? { name: d.name } : {}),
        ...(d.subject !== undefined && c.channel === "email" ? { subject: d.subject } : {}),
        ...(d.body !== undefined ? { body: d.body } : {}),
        ...(d.audience !== undefined ? { audience: d.audience as CampaignAudience } : {}),
        ...(d.templateId !== undefined
          ? c.channel === "email"
            ? { emailTemplateId: d.templateId }
            : { smsTemplateId: d.templateId }
          : {}),
      })
      .where(and(eq(campaignsTable.id, c.id), eq(campaignsTable.orgId, authReq.orgId)))
      .returning();
    res.json(serialize(row!));
  },
);

router.delete(
  "/campaigns/:id",
  requireAuth,
  requirePermission("communication", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const c = await loadCampaign(authReq.orgId, param(req, "id"));
    if (!c) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
    if (c.status !== "draft" && c.status !== "cancelled") {
      res.status(409).json({ error: "Sent campaigns are kept as a compliance record and cannot be deleted" });
      return;
    }
    if (c.status === "cancelled") {
      const [anySent] = await db
        .select({ id: campaignRecipientsTable.id })
        .from(campaignRecipientsTable)
        .where(and(eq(campaignRecipientsTable.campaignId, c.id), isNotNull(campaignRecipientsTable.sentAt)))
        .limit(1);
      if (anySent) {
        res.status(409).json({ error: "This campaign already reached some people and is kept as a record" });
        return;
      }
    }
    await db.delete(campaignsTable).where(and(eq(campaignsTable.id, c.id), eq(campaignsTable.orgId, authReq.orgId)));
    await audit(authReq, "delete", "campaign", c.id, { name: c.name });
    res.status(204).send();
  },
);

const SendSchema = z.object({ scheduledAt: z.string().datetime().nullable().optional() }).strict();

router.post(
  "/campaigns/:id/send",
  requireAuth,
  requirePermission("communication", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = SendSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }
    const c = await loadCampaign(authReq.orgId, param(req, "id"));
    if (!c) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
    if (c.status !== "draft") {
      res.status(409).json({ error: `Campaign is already ${c.status}` });
      return;
    }

    // Snapshot template content so later template edits don't change what
    // this campaign sends.
    let subject = c.subject;
    let body = c.body;
    if (c.channel === "email" && c.emailTemplateId) {
      const [t] = await db
        .select()
        .from(emailTemplatesTable)
        .where(and(eq(emailTemplatesTable.id, c.emailTemplateId), eq(emailTemplatesTable.orgId, authReq.orgId)))
        .limit(1);
      if (t) {
        subject = subject?.trim() ? subject : t.subject;
        body = body?.trim() ? body : t.bodyHtml;
      }
    } else if (c.channel === "sms" && c.smsTemplateId) {
      const [t] = await db
        .select()
        .from(smsTemplatesTable)
        .where(and(eq(smsTemplatesTable.id, c.smsTemplateId), eq(smsTemplatesTable.orgId, authReq.orgId)))
        .limit(1);
      if (t) body = body?.trim() ? body : t.body;
    }
    if (!body?.trim() || (c.channel === "email" && !subject?.trim())) {
      res.status(400).json({
        error: c.channel === "email" ? "Add a subject and message (or pick a template) before sending." : "Add a message (or pick a template) before sending.",
      });
      return;
    }

    const cfg = await configState(authReq.orgId);
    if (c.channel === "email") {
      if (!cfg.email.sendingConfigured) {
        res.status(409).json({ code: "email_not_configured", error: "Email sending isn't set up yet. An administrator needs to add the Resend API key." });
        return;
      }
      if (!cfg.email.senderAddressConfigured) {
        res.status(409).json({ code: "sender_address_missing", error: "Add your agency's mailing address in campaign settings first — the law (CAN-SPAM) requires it in every marketing email." });
        return;
      }
      if (!cfg.email.unsubscribeConfigured) {
        res.status(409).json({ code: "unsubscribe_not_configured", error: "Unsubscribe links aren't set up yet (CAMPAIGN_UNSUBSCRIBE_SECRET and APP_BASE_URL)." });
        return;
      }
    } else if (!cfg.sms.sendingConfigured) {
      res.status(409).json({ code: "sms_not_configured", error: "Text messaging isn't set up yet. An administrator needs to connect Twilio." });
      return;
    }

    const preview = await previewAudience(db, authReq.orgId, c.channel, c.audience ?? {});
    if (preview.eligible === 0) {
      res.status(409).json({ code: "empty_audience", error: "Nobody in this audience can receive this campaign.", preview });
      return;
    }

    const now = new Date();
    const scheduledAt = parsed.data.scheduledAt ? new Date(parsed.data.scheduledAt) : now;
    if (scheduledAt.getTime() > now.getTime() + 90 * 86_400_000) {
      res.status(400).json({ error: "Schedule within the next 90 days" });
      return;
    }

    const [row] = await db
      .update(campaignsTable)
      .set({ status: "scheduled", scheduledAt, subject, body })
      .where(and(eq(campaignsTable.id, c.id), eq(campaignsTable.orgId, authReq.orgId), eq(campaignsTable.status, "draft")))
      .returning();
    if (!row) {
      res.status(409).json({ error: "Campaign changed while sending — refresh and try again" });
      return;
    }
    await enqueue(
      JOB_NAMES.CAMPAIGN_SEND,
      { campaignId: c.id, orgId: authReq.orgId },
      scheduledAt.getTime() > now.getTime() ? { startAfter: scheduledAt } : undefined,
    );
    await audit(authReq, "send", "campaign", c.id, {
      channel: c.channel,
      scheduledAt: scheduledAt.toISOString(),
      eligible: preview.eligible,
      optedOutExcluded: preview.optedOut,
    });
    res.json({ ...serialize(row), preview });
  },
);

router.post(
  "/campaigns/:id/cancel",
  requireAuth,
  requirePermission("communication", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const c = await loadCampaign(authReq.orgId, param(req, "id"));
    if (!c) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
    const [row] = await db
      .update(campaignsTable)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(
        and(
          eq(campaignsTable.id, c.id),
          eq(campaignsTable.orgId, authReq.orgId),
          inArray(campaignsTable.status, ["scheduled", "sending"]),
        ),
      )
      .returning();
    if (!row) {
      res.status(409).json({ error: `A ${c.status} campaign can't be cancelled` });
      return;
    }
    await audit(authReq, "cancel", "campaign", c.id, { from: c.status });
    res.json(serialize(row));
  },
);

export default router;
