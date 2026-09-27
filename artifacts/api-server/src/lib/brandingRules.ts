/**
 * White-label validation rules (stage2/calendar-branding).
 *
 * Everything here ends up in CSS or in an email header at runtime, so the
 * rules are deliberately narrow: colours are `#rrggbb` only, fonts come from a
 * fixed allowlist of Google Fonts families, and asset URLs must be either an
 * object-storage path this app issued or an https URL.
 *
 * The same allowlists and contrast maths are mirrored in the web app
 * (artifacts/web-app/src/lib/branding/rules.ts) for live preview; the server
 * copy is the one that decides.
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

/** Text on the default light card surface. */
const WHITE = "#ffffff";

/** WCAG AA for normal text. */
export const CONTRAST_AA = 4.5;
/** WCAG AA for large text / UI components — our hard floor. */
export const CONTRAST_MIN = 3;

export const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export interface ContrastReport {
  errors: string[];
  warnings: string[];
}

/**
 * Brand colours are used as text and icon colours on white cards (links,
 * active states, headings) and as button fills. Below 3:1 against white the
 * product becomes hard to read, so we refuse it; between 3:1 and 4.5:1 we
 * accept it and warn.
 */
export function checkBrandContrast(colors: {
  primaryColor?: string | null;
  accentColor?: string | null;
}): ContrastReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const entries: Array<[string, string | null | undefined]> = [
    ["Primary colour", colors.primaryColor],
    ["Accent colour", colors.accentColor],
  ];
  for (const [label, hex] of entries) {
    if (!hex) continue;
    const ratio = contrastRatio(hex, WHITE);
    if (ratio < CONTRAST_MIN) {
      errors.push(
        `${label} ${hex} is too light to read on a white background (contrast ${ratio.toFixed(2)}:1, needs at least ${CONTRAST_MIN}:1). Pick a darker shade.`,
      );
    } else if (ratio < CONTRAST_AA) {
      warnings.push(
        `${label} ${hex} passes for large text only (contrast ${ratio.toFixed(2)}:1). A darker shade reads better in small text.`,
      );
    }
  }
  return { errors, warnings };
}

/**
 * An asset reference is either an object path minted by
 * POST /storage/uploads/confirm (`/objects/...`) or an https URL.
 */
export function isAllowedAssetUrl(v: string): boolean {
  if (/^\/objects\/[A-Za-z0-9/_.-]{1,300}$/.test(v) && !v.includes("..")) return true;
  try {
    const u = new URL(v);
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Safe for an email display name and for text rendering: no markup or header breaks. */
export const DISPLAY_TEXT_RE = /^[^<>"\\\r\n\t{}]*$/;
