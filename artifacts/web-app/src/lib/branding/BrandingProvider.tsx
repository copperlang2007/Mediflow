/**
 * Runtime white-label theming (stage2/calendar-branding).
 *
 * Loads GET /api/organizations/me/branding once per session and applies it on
 * top of the stage-1 design tokens:
 *
 *   - colours  → a <style id="org-branding-vars"> block overriding the HSL
 *                tokens (--primary, --accent, sidebar, KPI fills) for light
 *                mode, and the accent in dark mode only when it stays legible;
 *   - fonts    → an allowlisted Google Fonts <link> plus --app-font-display /
 *                --app-font-sans;
 *   - name / logo / mark → exposed through `useBranding()`, which BrandLockup
 *                reads;
 *   - favicon and document title.
 *
 * Every attribute falls back to the agencyBRIDGE default on its own, and any
 * failure to load simply leaves the defaults in place — a broken branding
 * call must never break the app shell.
 */
import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import {
  BRANDING_DEFAULTS,
  CONTRAST_AA,
  CONTRAST_MIN,
  SIDEBAR_TEXT,
  assetSrc,
  contrastRatio,
  googleFontsHref,
  hexToHslTriplet,
  readableForeground,
} from "./rules";

export interface BrandingData {
  orgName: string;
  productName: string | null;
  tagline: string | null;
  primaryColor: string | null;
  accentColor: string | null;
  displayFont: string | null;
  bodyFont: string | null;
  logoUrl: string | null;
  markUrl: string | null;
  faviconUrl: string | null;
  emailFromName: string | null;
  updatedAt: string | null;
  isDefault: boolean;
  options?: { displayFonts: string[]; bodyFonts: string[] };
  warnings?: string[];
}

export interface ResolvedBranding {
  productName: string;
  /** True when the agency set its own product name (the wordmark then shows it as-is). */
  customName: boolean;
  tagline: string | null;
  primaryColor: string | null;
  accentColor: string | null;
  displayFont: string;
  bodyFont: string;
  logoSrc: string | null;
  markSrc: string | null;
  faviconSrc: string | null;
}

export const DEFAULT_RESOLVED: ResolvedBranding = {
  productName: BRANDING_DEFAULTS.productName,
  customName: false,
  tagline: null,
  primaryColor: null,
  accentColor: null,
  displayFont: BRANDING_DEFAULTS.displayFont,
  bodyFont: BRANDING_DEFAULTS.bodyFont,
  logoSrc: null,
  markSrc: null,
  faviconSrc: null,
};

export function resolveBranding(d: Partial<BrandingData> | null | undefined): ResolvedBranding {
  if (!d) return DEFAULT_RESOLVED;
  const name = d.productName?.trim();
  return {
    productName: name || BRANDING_DEFAULTS.productName,
    customName: Boolean(name),
    tagline: d.tagline?.trim() || null,
    primaryColor: d.primaryColor ?? null,
    accentColor: d.accentColor ?? null,
    displayFont: d.displayFont ?? BRANDING_DEFAULTS.displayFont,
    bodyFont: d.bodyFont ?? BRANDING_DEFAULTS.bodyFont,
    logoSrc: assetSrc(d.logoUrl),
    markSrc: assetSrc(d.markUrl),
    faviconSrc: assetSrc(d.faviconUrl),
  };
}

const SERIF = new Set(["Playfair Display", "Merriweather", "Lora"]);
const fontStack = (f: string) => `'${f}', ${SERIF.has(f) ? "Georgia, serif" : "system-ui, sans-serif"}`;

function shiftLightness(triplet: string, delta: number): string {
  const [h, s, l] = triplet.split(" ");
  const next = Math.max(0, Math.min(100, parseInt(l, 10) + delta));
  return `${h} ${s} ${next}%`;
}

/**
 * CSS custom properties for a branding. `mode` picks the light or dark set;
 * dark mode only takes the accent, and only when it reads on the dark card.
 */
export function brandingVars(b: ResolvedBranding, mode: "light" | "dark"): Record<string, string> {
  const vars: Record<string, string> = {};
  if (mode === "light") {
    if (b.primaryColor) {
      const p = hexToHslTriplet(b.primaryColor);
      vars["--primary"] = p;
      vars["--primary-foreground"] = hexToHslTriplet(readableForeground(b.primaryColor));
      // The navy sidebar becomes the brand colour only when its light text
      // stays readable on it; otherwise the default sidebar is kept.
      if (contrastRatio(b.primaryColor, SIDEBAR_TEXT) >= CONTRAST_AA) {
        vars["--sidebar"] = p;
        vars["--sidebar-accent"] = shiftLightness(p, 7);
        vars["--sidebar-border"] = shiftLightness(p, 10);
        vars["--kpi-navy-from"] = `hsl(${shiftLightness(p, 10)})`;
        vars["--kpi-navy-to"] = `hsl(${p})`;
      }
      vars["--chart-2"] = p;
    }
    if (b.accentColor) {
      const a = hexToHslTriplet(b.accentColor);
      vars["--accent"] = a;
      vars["--accent-foreground"] = hexToHslTriplet(readableForeground(b.accentColor));
      vars["--ring"] = a;
      vars["--info"] = a;
      vars["--chart-1"] = a;
      if (contrastRatio(b.accentColor, "#ffffff") >= CONTRAST_MIN) {
        vars["--sidebar-primary"] = a;
        vars["--sidebar-primary-foreground"] = hexToHslTriplet(readableForeground(b.accentColor));
        vars["--kpi-blue-from"] = `hsl(${shiftLightness(a, 8)})`;
        vars["--kpi-blue-to"] = `hsl(${a})`;
      }
    }
  } else if (b.accentColor && contrastRatio(b.accentColor, "#0f1b3d") >= CONTRAST_AA) {
    const a = hexToHslTriplet(b.accentColor);
    vars["--accent"] = a;
    vars["--primary"] = a;
    vars["--ring"] = a;
    vars["--sidebar-primary"] = a;
    const fg = hexToHslTriplet(readableForeground(b.accentColor));
    vars["--accent-foreground"] = fg;
    vars["--primary-foreground"] = fg;
    vars["--sidebar-primary-foreground"] = fg;
  }
  if (b.displayFont !== BRANDING_DEFAULTS.displayFont) vars["--app-font-display"] = fontStack(b.displayFont);
  if (b.bodyFont !== BRANDING_DEFAULTS.bodyFont) vars["--app-font-sans"] = fontStack(b.bodyFont);
  return vars;
}

function toCss(selector: string, vars: Record<string, string>): string {
  const body = Object.entries(vars)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  return body ? `${selector} {\n${body}\n}` : "";
}

export function brandingStylesheet(b: ResolvedBranding): string {
  return [
    toCss(":root:not(.dark)", brandingVars(b, "light")),
    toCss(":root.dark", brandingVars(b, "dark")),
  ]
    .filter(Boolean)
    .join("\n");
}

interface BrandingContextValue {
  data: BrandingData | null;
  resolved: ResolvedBranding;
  loading: boolean;
  refresh: () => Promise<void>;
}

const BrandingContext = createContext<BrandingContextValue | null>(null);

export const BRANDING_QUERY_KEY = ["/api/organizations/me/branding"] as const;

function upsertHeadElement<T extends HTMLElement>(id: string, create: () => T): T {
  let el = document.getElementById(id) as T | null;
  if (!el) {
    el = create();
    el.id = id;
    document.head.appendChild(el);
  }
  return el;
}

export function BrandingProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: BRANDING_QUERY_KEY,
    queryFn: () => apiFetch<BrandingData>("/api/organizations/me/branding"),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const resolved = useMemo(() => resolveBranding(data), [data]);

  // Colours + fonts.
  useEffect(() => {
    const css = brandingStylesheet(resolved);
    const style = upsertHeadElement("org-branding-vars", () => document.createElement("style"));
    style.textContent = css;

    const href = googleFontsHref(
      [resolved.displayFont, resolved.bodyFont].filter(
        (f) => f !== BRANDING_DEFAULTS.displayFont && f !== BRANDING_DEFAULTS.bodyFont,
      ),
    );
    const existing = document.getElementById("org-branding-fonts") as HTMLLinkElement | null;
    if (href) {
      const link = upsertHeadElement("org-branding-fonts", () => {
        const l = document.createElement("link");
        l.rel = "stylesheet";
        return l;
      });
      if (link.href !== href) link.href = href;
    } else if (existing) {
      existing.remove();
    }
  }, [resolved]);

  // Favicon + title.
  useEffect(() => {
    const icon = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
    const original = icon?.getAttribute("data-default-href") ?? icon?.getAttribute("href") ?? null;
    if (icon && original && !icon.hasAttribute("data-default-href")) {
      icon.setAttribute("data-default-href", original);
    }
    if (icon) icon.href = resolved.faviconSrc ?? original ?? icon.href;
    if (resolved.customName) {
      document.title = resolved.tagline
        ? `${resolved.productName} — ${resolved.tagline}`
        : resolved.productName;
    }
  }, [resolved]);

  const value = useMemo<BrandingContextValue>(
    () => ({
      data: data ?? null,
      resolved,
      loading: isLoading,
      refresh: async () => {
        await qc.invalidateQueries({ queryKey: BRANDING_QUERY_KEY });
      },
    }),
    [data, resolved, isLoading, qc],
  );

  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

/** Branding for the current org; agencyBRIDGE defaults outside a provider. */
export function useBranding(): BrandingContextValue {
  return (
    useContext(BrandingContext) ?? {
      data: null,
      resolved: DEFAULT_RESOLVED,
      loading: false,
      refresh: async () => undefined,
    }
  );
}

/** Lets a preview area render BrandLockup with unsaved values. */
export function BrandingPreviewProvider({
  value,
  children,
}: {
  value: ResolvedBranding;
  children: ReactNode;
}) {
  const parent = useBranding();
  return (
    <BrandingContext.Provider value={{ ...parent, resolved: value }}>{children}</BrandingContext.Provider>
  );
}
