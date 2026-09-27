/**
 * White-label rules for the browser (stage2/calendar-branding).
 *
 * Mirrors artifacts/api-server/src/lib/brandingRules.ts so the editor can show
 * contrast results and font choices live. The server re-validates everything;
 * this copy only drives the preview.
 */

export const DISPLAY_FONTS = [
  "Outfit",
  "Poppins",
  "Montserrat",
  "Raleway",
  "Nunito",
  "DM Sans",
  "Manrope",
  "Playfair Display",
  "Merriweather",
  "Lora",
] as const;

export const BODY_FONTS = [
  "Figtree",
  "Inter",
  "Open Sans",
  "Lato",
  "Roboto",
  "Source Sans 3",
  "Nunito Sans",
  "Work Sans",
  "DM Sans",
] as const;

export const BRANDING_DEFAULTS = {
  productName: "agencyBRIDGE",
  tagline: "Agency Platform",
  primaryColor: "#0f1b3d",
  accentColor: "#28507f",
  displayFont: "Outfit",
  bodyFont: "Figtree",
} as const;

export const HEX_RE = /^#[0-9a-fA-F]{6}$/;
export const CONTRAST_AA = 4.5;
export const CONTRAST_MIN = 3;

/** The sidebar's light text colour (navy-100). */
export const SIDEBAR_TEXT = "#e8edf3";

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = rgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export type ContrastLevel = "good" | "large-only" | "fail";

export function contrastLevel(hex: string, against = "#ffffff"): { ratio: number; level: ContrastLevel } {
  const ratio = contrastRatio(hex, against);
  return {
    ratio,
    level: ratio >= CONTRAST_AA ? "good" : ratio >= CONTRAST_MIN ? "large-only" : "fail",
  };
}

/** "#1e3a5f" → "213 52% 25%" — the HSL triplet format the CSS tokens use. */
export function hexToHslTriplet(hex: string): string {
  const [r8, g8, b8] = rgb(hex);
  const r = r8 / 255;
  const g = g8 / 255;
  const b = b8 / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h *= 60;
  }
  return `${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

/** Best text colour (near-white or near-black) on top of `hex`. */
export function readableForeground(hex: string): string {
  return contrastRatio(hex, "#ffffff") >= contrastRatio(hex, "#0b1220") ? "#ffffff" : "#0b1220";
}

/** Google Fonts stylesheet URL for the chosen families (allowlisted only). */
export function googleFontsHref(families: string[]): string | null {
  const allowed = new Set<string>([...DISPLAY_FONTS, ...BODY_FONTS]);
  const picked = Array.from(new Set(families.filter((f) => allowed.has(f))));
  if (picked.length === 0) return null;
  const q = picked
    .map((f) => `family=${encodeURIComponent(f).replace(/%20/g, "+")}:wght@400;500;600;700`)
    .join("&");
  return `https://fonts.googleapis.com/css2?${q}&display=swap`;
}

/** Turns a stored asset reference into something an <img> can load. */
export function assetSrc(ref: string | null | undefined): string | null {
  if (!ref) return null;
  if (ref.startsWith("/objects/")) {
    const base = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
    return `${base}/api/storage${ref}`;
  }
  return ref.startsWith("https://") ? ref : null;
}
