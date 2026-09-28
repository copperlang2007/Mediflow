/**
 * Small layout helpers for the restyled money / compliance / ops / admin
 * pages, so they share one agencyBRIDGE rhythm on top of the stage-1 shared
 * components (PageHeader, KpiCard, SectionCard, StatusPill, EmptyState):
 *
 *   <PageShell>
 *     <PageHeader … />
 *     <KpiGrid>…KpiCard…</KpiGrid>
 *     <SectionCard>
 *       <FilterBar>…</FilterBar>
 *       <TableFrame><Table>…</Table></TableFrame>
 *     </SectionCard>
 *   </PageShell>
 */
import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Standard page padding + width, matching the stage-1 dashboard. */
export function PageShell({
  children,
  className,
  wide = false,
}: {
  children: ReactNode;
  className?: string;
  /** Full-width pages (wallboards, big grids). */
  wide?: boolean;
}) {
  return (
    <div
      className={cn(
        "p-4 sm:p-6 lg:p-8 space-y-6 mx-auto",
        wide ? "max-w-[1600px]" : "max-w-7xl",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Responsive row of KPI cards (1 → 2 → 4 columns by default). */
export function KpiGrid({
  children,
  cols = 4,
  className,
}: {
  children: ReactNode;
  cols?: 2 | 3 | 4 | 5;
  className?: string;
}) {
  const colClass = {
    2: "sm:grid-cols-2",
    3: "sm:grid-cols-2 lg:grid-cols-3",
    4: "sm:grid-cols-2 lg:grid-cols-4",
    5: "sm:grid-cols-2 lg:grid-cols-5",
  }[cols];
  return <div className={cn("grid grid-cols-1 gap-4", colClass, className)}>{children}</div>;
}

/**
 * Rounded, bordered frame around a shadcn <Table>, with the agencyBRIDGE
 * tinted header row and soft row hover.
 */
export function TableFrame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border overflow-hidden bg-card",
        "[&_thead_tr]:bg-muted/50 [&_thead_tr:hover]:bg-muted/50",
        "[&_th]:text-xs [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-muted-foreground",
        "[&_tbody_tr:hover]:bg-muted/30",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Search / filter row that sits at the top of a SectionCard. */
export function FilterBar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-wrap items-center gap-2 mb-4", className)}>{children}</div>;
}

/**
 * A plain-language note that a feature needs setup or is on its way.
 * Use it instead of fake numbers: say what will happen once it's ready.
 */
export function NoticeBanner({
  icon: Icon,
  title,
  children,
  tone = "info",
  action,
  className,
}: {
  icon?: ComponentType<{ className?: string }>;
  title: ReactNode;
  children?: ReactNode;
  tone?: "info" | "warning" | "success" | "danger";
  action?: ReactNode;
  className?: string;
}) {
  const toneClass = {
    info: "border-accent/25 bg-accent/5",
    warning: "border-warning/30 bg-warning/10",
    success: "border-success/25 bg-success/10",
    danger: "border-destructive/25 bg-destructive/5",
  }[tone];
  const iconClass = {
    info: "bg-accent/10 text-accent",
    warning: "bg-warning/15 text-amber-700 dark:text-warning",
    success: "bg-success/15 text-success",
    danger: "bg-destructive/10 text-destructive",
  }[tone];
  return (
    <div className={cn("flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center", toneClass, className)}>
      {Icon && (
        <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-lg", iconClass)}>
          <Icon className="h-5 w-5" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="font-display font-semibold text-sm text-foreground">{title}</p>
        {children && <div className="text-sm text-muted-foreground mt-0.5">{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
