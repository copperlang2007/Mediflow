import { useId } from "react";
import { cn } from "@/lib/utils";
import { useBranding } from "@/lib/branding/BrandingProvider";

/**
 * agencyBRIDGE identity — the suspension-bridge mark and the
 * "agencyBRIDGE" wordmark lockup, ported from the agencyBRIDGE prototype.
 *
 * Drawn as SVG geometry (not type) so it renders identically without a
 * webfont and stays legible at favicon sizes. `public/logo.svg` and
 * `public/favicon.svg` are the same drawing for places that need a URL
 * (the sign-in screens, the browser tab).
 */

export type BrandMarkTone = "brand" | "light" | "dark" | "mono";

const TILE_GRADIENT = "__gradient__";

const TONES: Record<BrandMarkTone, { tile: string; ink: string }> = {
  // Navy gradient tile, near-white bridge — for light and neutral surfaces.
  brand: { tile: TILE_GRADIENT, ink: "#e8edf3" },
  // Light tile, navy bridge — for dark surfaces such as the sidebar.
  light: { tile: "#e8edf3", ink: "#0f1b3d" },
  dark: { tile: "#0f1b3d", ink: "#e8edf3" },
  mono: { tile: "none", ink: "currentColor" },
};

export function BrandMark({
  size = 36,
  tone = "brand",
  className,
  title = "agencyBRIDGE",
  decorative = false,
}: {
  size?: number;
  tone?: BrandMarkTone;
  className?: string;
  title?: string;
  /** Set when an adjacent wordmark already names the brand. */
  decorative?: boolean;
}) {
  // A fixed gradient id would collide when two marks share a page.
  const gradientId = `ab-tile-${useId().replace(/:/g, "")}`;
  const { tile, ink } = TONES[tone];
  const fill = tile === TILE_GRADIENT ? `url(#${gradientId})` : tile;
  const stroked = tone === "mono";

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role={decorative ? "presentation" : "img"}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : title}
      className={cn("shrink-0", className)}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#28507f" />
          <stop offset="100%" stopColor="#0f1b3d" />
        </linearGradient>
      </defs>
      <rect
        width="32"
        height="32"
        rx="7.5"
        fill={fill}
        stroke={stroked ? ink : "none"}
        strokeWidth={stroked ? 1.5 : 0}
      />
      <g stroke={ink} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" fill="none">
        <path d="M11 8.4 Q16 17.4 21 8.4" />
        <path d="M5.5 18.4 L11 8.4" />
        <path d="M21 8.4 L26.5 18.4" />
        <path d="M4.5 20.6 H27.5" />
        <path d="M11 23.4 V7.2" />
        <path d="M21 23.4 V7.2" />
      </g>
    </svg>
  );
}

/**
 * Mark + "agencyBRIDGE" wordmark. `compact` shows the mark only.
 *
 * White-label aware (stage2/calendar-branding): inside a BrandingProvider the
 * agency's product name, tagline, mark and full logo replace the defaults
 * one by one; outside one (sign-in, landing) it is always agencyBRIDGE.
 */
export function BrandLockup({
  size = 36,
  tone = "brand",
  compact = false,
  subtitle,
  className,
  wordmarkClassName,
  subtitleClassName,
}: {
  size?: number;
  tone?: BrandMarkTone;
  compact?: boolean;
  subtitle?: string;
  className?: string;
  wordmarkClassName?: string;
  subtitleClassName?: string;
}) {
  const { resolved } = useBranding();
  const shownSubtitle = resolved.tagline ?? subtitle;

  // A full logo lockup replaces mark + wordmark when there is room for it.
  // It sits on a light chip so a dark logo stays visible on the navy sidebar.
  if (!compact && resolved.logoSrc) {
    return (
      <div className={cn("flex items-center min-w-0", className)}>
        <span className={cn("inline-flex items-center rounded-lg", tone === "light" && "bg-white/95 px-2 py-1")}>
          <img
            src={resolved.logoSrc}
            alt={resolved.productName}
            style={{ height: Math.round(size * 0.8) }}
            className="max-w-[180px] object-contain"
          />
        </span>
      </div>
    );
  }

  return (
    <div className={cn("flex items-center gap-3 min-w-0", className)}>
      {resolved.markSrc ? (
        <img
          src={resolved.markSrc}
          alt={compact ? resolved.productName : ""}
          width={size}
          height={size}
          className="shrink-0 rounded-[7px] object-contain"
        />
      ) : (
        <BrandMark size={size} tone={tone} decorative={!compact} title={resolved.productName} />
      )}
      {!compact && (
        <div className="flex flex-col leading-tight overflow-hidden">
          <span className={cn("font-display font-bold tracking-tight truncate", wordmarkClassName)}>
            {resolved.customName ? (
              resolved.productName
            ) : (
              <>
                agency<span className="font-extrabold">BRIDGE</span>
              </>
            )}
          </span>
          {shownSubtitle && (
            <span className={cn("text-[11px] opacity-60 truncate", subtitleClassName)}>{shownSubtitle}</span>
          )}
        </div>
      )}
    </div>
  );
}
