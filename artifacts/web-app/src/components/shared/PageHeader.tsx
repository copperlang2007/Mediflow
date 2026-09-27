import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Page title block in the agencyBRIDGE style: big Outfit title, a one-line
 * plain-language subtitle underneath, and optional action buttons on the right
 * (they wrap below the title on narrow screens).
 *
 *   <PageHeader title="Clients & Leads" subtitle="Everyone you work with, in one list">
 *     <Button>Add client</Button>
 *   </PageHeader>
 */
export function PageHeader({
  title,
  subtitle,
  eyebrow,
  children,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Small uppercase label above the title (optional). */
  eyebrow?: ReactNode;
  /** Actions (buttons, filters) shown on the right. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-4 md:flex-row md:items-center md:justify-between",
        className,
      )}
    >
      <div className="min-w-0">
        {eyebrow && (
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
            {eyebrow}
          </p>
        )}
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}
