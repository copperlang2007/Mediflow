/**
 * Agency white-label branding (stage2/calendar-branding).
 *
 *   GET    /organizations/me/branding   — any signed-in member of the org
 *   PUT    /organizations/me/branding   — agency_admin / super_admin (`org:update`)
 *   DELETE /organizations/me/branding   — reset to the agencyBRIDGE defaults
 *
 * GET is intentionally open to every role in the org: the web app's
 * BrandingProvider needs the colours, fonts, name and logo to draw the shell
 * for agents too, and none of it is sensitive. It is still org-scoped — the
 * row is read by `authReq.orgId`, never by a client-supplied id.
 *
 * Custom domains are not implemented; the page says "Coming soon".
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, organizationsTable, orgBrandingTable, type OrgBranding } from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { auditMiddleware } from "../middlewares/auditMiddleware";
import {
  BODY_FONTS,
  BRANDING_DEFAULTS,
  DISPLAY_FONTS,
  DISPLAY_TEXT_RE,
  HEX_RE,
  checkBrandContrast,
  isAllowedAssetUrl,
} from "../lib/brandingRules";

const router: IRouter = Router();

const audit = auditMiddleware("org", "update", { getResourceId: () => "branding" });

const hex = z
  .string()
  .regex(HEX_RE, "Colours must be 6-digit hex, e.g. #1e3a5f")
  .transform((v) => v.toLowerCase());

const displayText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .regex(DISPLAY_TEXT_RE, "Remove < > \" \\ { } and line breaks");

const assetUrl = z
  .string()
  .trim()
  .max(500)
  .refine(isAllowedAssetUrl, "Must be an uploaded file or an https:// URL");

// Every field optional + nullable: omitted = unchanged, null/"" = back to default.
const PutSchema = z
  .object({
    productName: displayText(40).nullable().optional(),
    tagline: displayText(80).nullable().optional(),
    primaryColor: hex.nullable().optional(),
    accentColor: hex.nullable().optional(),
    displayFont: z.enum(DISPLAY_FONTS).nullable().optional(),
    bodyFont: z.enum(BODY_FONTS).nullable().optional(),
    logoUrl: assetUrl.nullable().optional(),
    markUrl: assetUrl.nullable().optional(),
    faviconUrl: assetUrl.nullable().optional(),
    emailFromName: displayText(60).nullable().optional(),
  })
  .strict();

function blankToNull<T>(v: T | null | undefined): T | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === "string" && v.trim() === "") return null;
  return v;
}

function present(
  row: OrgBranding | undefined,
  org: { name: string; logoUrl: string | null },
) {
  return {
    orgName: org.name,
    productName: row?.productName ?? null,
    tagline: row?.tagline ?? null,
    primaryColor: row?.primaryColor ?? null,
    accentColor: row?.accentColor ?? null,
    displayFont: row?.displayFont ?? null,
    bodyFont: row?.bodyFont ?? null,
    logoUrl: org.logoUrl ?? null,
    markUrl: row?.markUrl ?? null,
    faviconUrl: row?.faviconUrl ?? null,
    emailFromName: row?.emailFromName ?? null,
    updatedAt: row?.updatedAt ?? null,
    isDefault:
      !org.logoUrl &&
      (!row ||
        [
          row.productName,
          row.tagline,
          row.primaryColor,
          row.accentColor,
          row.displayFont,
          row.bodyFont,
          row.markUrl,
          row.faviconUrl,
          row.emailFromName,
        ].every((v) => v == null)),
    defaults: BRANDING_DEFAULTS,
    options: { displayFonts: DISPLAY_FONTS, bodyFonts: BODY_FONTS },
  };
}

async function load(orgId: string) {
  const [[org], [row]] = await Promise.all([
    db
      .select({ name: organizationsTable.name, logoUrl: organizationsTable.logoUrl })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId))
      .limit(1),
    db.select().from(orgBrandingTable).where(eq(orgBrandingTable.orgId, orgId)).limit(1),
  ]);
  return { org, row };
}

router.get(
  "/organizations/me/branding",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { org, row } = await load(authReq.orgId);
    if (!org) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    res.json(present(row, org));
  },
);

router.put(
  "/organizations/me/branding",
  requireAuth,
  requirePermission("org", "update"),
  audit,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = PutSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid branding", details: parsed.error.issues });
      return;
    }
    const d = parsed.data;
    const { org, row: current } = await load(authReq.orgId);
    if (!org) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }

    // Contrast is judged on the colours that will actually be in effect.
    const effectivePrimary =
      d.primaryColor !== undefined ? d.primaryColor : (current?.primaryColor ?? null);
    const effectiveAccent =
      d.accentColor !== undefined ? d.accentColor : (current?.accentColor ?? null);
    const contrast = checkBrandContrast({
      primaryColor: effectivePrimary,
      accentColor: effectiveAccent,
    });
    if (contrast.errors.length > 0) {
      res.status(400).json({
        error: contrast.errors[0],
        code: "low_contrast",
        details: contrast.errors,
      });
      return;
    }

    const values = {
      productName: blankToNull(d.productName),
      tagline: blankToNull(d.tagline),
      primaryColor: blankToNull(d.primaryColor),
      accentColor: blankToNull(d.accentColor),
      displayFont: blankToNull(d.displayFont),
      bodyFont: blankToNull(d.bodyFont),
      markUrl: blankToNull(d.markUrl),
      faviconUrl: blankToNull(d.faviconUrl),
      emailFromName: blankToNull(d.emailFromName),
    };
    const set: Partial<typeof orgBrandingTable.$inferInsert> = { updatedBy: authReq.userId };
    for (const [k, v] of Object.entries(values)) {
      if (v !== undefined) (set as Record<string, unknown>)[k] = v;
    }

    await db.transaction(async (tx) => {
      await tx
        .insert(orgBrandingTable)
        .values({ orgId: authReq.orgId, ...set })
        .onConflictDoUpdate({ target: orgBrandingTable.orgId, set: { ...set, updatedAt: new Date() } });
      const logo = blankToNull(d.logoUrl);
      if (logo !== undefined) {
        await tx
          .update(organizationsTable)
          .set({ logoUrl: logo })
          .where(eq(organizationsTable.id, authReq.orgId));
      }
    });

    const fresh = await load(authReq.orgId);
    res.json({ ...present(fresh.row, fresh.org!), warnings: contrast.warnings });
  },
);

router.delete(
  "/organizations/me/branding",
  requireAuth,
  requirePermission("org", "update"),
  audit,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    await db.transaction(async (tx) => {
      await tx.delete(orgBrandingTable).where(eq(orgBrandingTable.orgId, authReq.orgId));
      await tx
        .update(organizationsTable)
        .set({ logoUrl: null })
        .where(eq(organizationsTable.id, authReq.orgId));
    });
    const fresh = await load(authReq.orgId);
    if (!fresh.org) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    res.json(present(fresh.row, fresh.org));
  },
);

export default router;
