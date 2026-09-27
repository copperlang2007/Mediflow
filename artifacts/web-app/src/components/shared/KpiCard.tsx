import type { ComponentType, CSSProperties, ReactNode } from "react";
import { Link } from "wouter";
import { TrendingDown, TrendingUp } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export type KpiColor = "navy" | "blue" | "green" | "orange";

type IconType = ComponentType<{ className?: string }>;

/**
 * A trend line under the number. Only pass one when you have a real
 * comparison from the API — never an invented percentage.
 */
export type KpiTrend = {
  /** e.g. "+4 this week" or "12%" — rendered as given. */
  label: ReactNode;
  direction?: "up" | "down";
  /** Muted text after the label, e.g. "vs last month". */
  context?: ReactNode;
};

const SOLID_BG: Record<KpiColor, CSSProperties> = {
  navy: { backgroundImage: "linear-gradient(135deg, var(--kpi-navy-from), var(--kpi-navy-to))" },
  blue: { backgroundImage: "linear-gradient(135deg, var(--kpi-blue-from), var(--kpi-blue-to))" },
  green: { backgroundImage: "linear-gradient(135deg, var(--kpi-green-from), var(--kpi-green-to))" },
  orange: { backgroundImage: "linear-gradient(135deg, var(--kpi-orange-from), var(--kpi-orange-to))" },
};

const WHITE_ICON: Record<KpiColor, string> = {
  navy: "bg-navy-100 text-navy-800 dark:bg-secondary dark:text-secondary-foreground",
  blue: "bg-sky-100 text-navy-600 dark:bg-secondary dark:text-accent",
  green: "bg-success/15 text-success",
  orange: "bg-warning/15 text-warning",
};

/**
 * Headline number card from the agencyBRIDGE dashboard.
 *
 * - `variant="solid"` (default): coloured gradient card with white text and a
 *   frosted icon tile — use for the row of four headline KPIs.
 * - `variant="white"`: white card with a tinted icon tile — use for secondary
 *   numbers on list pages.
 *
 * Pass `href` to make the whole card a link to the page behind the number.
 */
export function KpiCard({
  label,
  value,
  icon: Icon,
  color = "navy",
  variant = "solid",
  hint,
  trend,
  href,
  loading,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  icon: IconType;
  color?: KpiColor;
  variant?: "solid" | "white";
  /** Short plain-language line under the number, e.g. "3 overdue". */
  hint?: ReactNode;
  trend?: KpiTrend;
  href?: string;
  loading?: boolean;
  className?: string;
}) {
  const solid = variant === "solid";
  const TrendIcon = trend?.direction === "down" ? TrendingDown : TrendingUp;

  const body = (
    <div
      className={cn(
        "relative h-full overflow-hidden rounded-xl p-5 transition-shadow",
        solid
          ? "text-white shadow-md"
          : "border border-border bg-card text-card-foreground shadow-sm",
        href && "hover:shadow-lg cursor-pointer",
        className,
      )}
      style={solid ? SOLID_BG[color] : undefined}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={cn("text-sm font-medium mb-1", solid ? "text-white/75" : "text-muted-foreground")}>
            {label}
          </p>
          {loading ? (
            <Skeleton className={cn("h-9 w-20 mt-1", solid && "bg-white/20")} />
          ) : (
            <p className="font-display text-3xl font-bold tracking-tight leading-tight">{value}</p>
          )}
          {trend && !loading && (
            <p className={cn("mt-2 flex items-center gap-1.5 text-sm", solid ? "text-white/85" : "text-muted-foreground")}>
              <TrendIcon className="h-4 w-4 shrink-0" />
              <span>
                {trend.label}
                {trend.context && (
                  <span className={solid ? "text-white/60" : "text-muted-foreground/80"}> {trend.context}</span>
                )}
              </span>
            </p>
          )}
          {hint && !loading && (
            <p className={cn("mt-2 text-sm", solid ? "text-white/80" : "text-muted-foreground")}>{hint}</p>
          )}
        </div>
        <div
          className={cn(
            "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl",
            solid ? "bg-white/15 text-white" : WHITE_ICON[color],
          )}
        >
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );

  return href ? (
    <Link href={href} className="block h-full rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {body}
    </Link>
  ) : (
    body
  );
}

/**
 * Small white stat tile (icon on the left, label above a number) — the
 * secondary row under the KPI cards on the agencyBRIDGE dashboard.
 */
export function MiniStat({
  label,
  value,
  icon: Icon,
  href,
  loading,
  tone = "default",
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  icon: IconType;
  href?: string;
  loading?: boolean;
  /** Tints the icon tile when the number needs attention. */
  tone?: "default" | "warning" | "danger" | "success";
  className?: string;
}) {
  const toneClass =
    tone === "warning"
      ? "bg-warning/15 text-warning"
      : tone === "danger"
        ? "bg-destructive/10 text-destructive"
        : tone === "success"
          ? "bg-success/15 text-success"
          : "bg-muted text-accent";

  const body = (
    <div
      className={cn(
        "h-full rounded-xl border border-border bg-card p-4 shadow-sm transition-shadow",
        href && "hover:shadow-md cursor-pointer",
        className,
      )}
    >
      <div className="flex items-center gap-3">
        <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-lg", toneClass)}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground truncate">{label}</p>
          {loading ? (
            <Skeleton className="h-6 w-12 mt-1" />
          ) : (
            <p className="font-display text-xl font-bold leading-tight">{value}</p>
          )}
        </div>
      </div>
    </div>
  );

  return href ? (
    <Link href={href} className="block h-full rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {body}
    </Link>
  ) : (
    body
  );
}
