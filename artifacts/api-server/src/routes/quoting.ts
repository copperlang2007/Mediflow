/**
 * Quoting Engine helpers.
 *
 *   GET /quoting/providers?lastName=&firstName=&state=&zip=
 *
 * Doctor lookup through the public CMS NPPES NPI Registry
 * (https://npiregistry.cms.hhs.gov/api/). Plan / premium / formulary data is
 * NOT connected yet, so this is the only live piece of the quoting page.
 *
 * Server-side proxy on purpose, so the browser never talks to a third party
 * and the request is controlled here:
 *   - signed-in staff with `contact:read` only, org-authenticated as usual;
 *   - strict input validation (names, 2-letter state, 5-digit ZIP);
 *   - per-user rate limit;
 *   - hard timeout on the upstream call;
 *   - search terms are never logged — a doctor's name next to a member's ZIP
 *     can hint at a member's health, so only status / timing are logged.
 * Only public provider-directory fields come back; nothing about a member is
 * ever sent upstream.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

export const NPPES_URL = "https://npiregistry.cms.hhs.gov/api/";
const UPSTREAM_TIMEOUT_MS = 6_000;
const RESULT_LIMIT = 20;

const providerLookupLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  keyGenerator: (req) => (req as AuthenticatedRequest).userId ?? req.ip ?? "unknown",
  message: { error: "Too many doctor searches — please wait a minute and try again." },
});

const name = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .regex(/^[A-Za-z][A-Za-z .'-]*$/, "letters, spaces, apostrophes and hyphens only");

const Query = z.object({
  lastName: name,
  firstName: name.optional(),
  state: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/)
    .transform((s) => s.toUpperCase())
    .optional(),
  zip: z.string().trim().regex(/^\d{5}$/).optional(),
});

type NppesAddress = {
  address_purpose?: string;
  address_1?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  telephone_number?: string;
};
type NppesResult = {
  number?: number | string;
  basic?: {
    first_name?: string;
    last_name?: string;
    credential?: string;
    organization_name?: string;
  };
  addresses?: NppesAddress[];
  taxonomies?: { desc?: string; primary?: boolean }[];
};

export interface ProviderResult {
  npi: string;
  name: string;
  credential: string | null;
  specialty: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

export function mapNppesResult(r: NppesResult): ProviderResult | null {
  if (r.number == null) return null;
  const b = r.basic ?? {};
  const fullName = b.organization_name
    ? b.organization_name
    : [b.first_name, b.last_name].filter(Boolean).join(" ");
  const loc =
    r.addresses?.find((a) => a.address_purpose === "LOCATION") ?? r.addresses?.[0];
  const tax = r.taxonomies?.find((t) => t.primary) ?? r.taxonomies?.[0];
  return {
    npi: String(r.number),
    name: titleCase(fullName || "Unknown provider"),
    credential: b.credential ?? null,
    specialty: tax?.desc ?? null,
    address: loc?.address_1 ? titleCase(loc.address_1) : null,
    city: loc?.city ? titleCase(loc.city) : null,
    state: loc?.state ?? null,
    zip: loc?.postal_code ? loc.postal_code.slice(0, 5) : null,
    phone: loc?.telephone_number ?? null,
  };
}

router.get(
  "/quoting/providers",
  requireAuth,
  requirePermission("contact", "read"),
  providerLookupLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = Query.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: "Enter the doctor's last name (letters only), and optionally a first name, 2-letter state or 5-digit ZIP.",
      });
      return;
    }
    const q = parsed.data;
    const url = new URL(NPPES_URL);
    url.searchParams.set("version", "2.1");
    url.searchParams.set("enumeration_type", "NPI-1");
    url.searchParams.set("last_name", q.lastName);
    if (q.firstName) url.searchParams.set("first_name", q.firstName);
    if (q.state) url.searchParams.set("state", q.state);
    if (q.zip) url.searchParams.set("postal_code", q.zip);
    url.searchParams.set("limit", String(RESULT_LIMIT));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    const startedAt = Date.now();
    try {
      const upstream = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!upstream.ok) {
        logger.warn({ status: upstream.status, ms: Date.now() - startedAt }, "NPPES lookup: upstream error");
        res.status(502).json({ error: "The public doctor directory isn't responding right now. Try again shortly." });
        return;
      }
      const body = (await upstream.json()) as { results?: NppesResult[]; Errors?: unknown[] };
      if (Array.isArray(body.Errors) && body.Errors.length > 0) {
        res.status(400).json({ error: "The doctor directory needs a more specific search (add a first name, state or ZIP)." });
        return;
      }
      const data = (body.results ?? [])
        .map(mapNppesResult)
        .filter((r): r is ProviderResult => r !== null);
      logger.info({ results: data.length, ms: Date.now() - startedAt }, "NPPES lookup ok");
      res.set("Cache-Control", "no-store");
      res.json({ data, total: data.length, source: "CMS NPPES NPI Registry" });
    } catch (err) {
      const aborted = (err as Error)?.name === "AbortError";
      logger.warn({ aborted, ms: Date.now() - startedAt }, "NPPES lookup failed");
      res.status(aborted ? 504 : 502).json({
        error: "The public doctor directory isn't reachable right now. Try again shortly.",
      });
    } finally {
      clearTimeout(timer);
    }
  },
);

export default router;
