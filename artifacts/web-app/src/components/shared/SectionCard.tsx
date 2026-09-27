import type { ComponentType, ReactNode } from "react";
import { Link } from "wouter";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * White rounded panel with a title row — the building block for every
 * dashboard/list section in the agencyBRIDGE look.
 *
 *   <SectionCard title="Recent activity" description="Last 15 updates"
 *                action={{ label: "See all", href: "/tasks" }}>
 *     …
 *   </SectionCard>
 */
export function SectionCard({
  title,
  description,
  icon: Icon,
  iconClassName,
  action,
  actions,
  children,
  className,
  contentClassName,
}: {
  title?: ReactNode;
  description?: ReactNode;
  icon?: ComponentType<{ className?: string }>;
  iconClassName?: string;
  /** A single "View details →" style link button in the header. */
  action?: { label: string; href: string };
  /** Arbitrary header controls (use instead of `action` for custom buttons). */
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  const hasHeader = Boolean(title || description || action || actions);
  return (
    <section
      className={cn(
        "rounded-xl border border-border bg-card text-card-foreground shadow-sm",
        className,
      )}
    >
      {hasHeader && (
        <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3">
          <div className="min-w-0">
            {title && (
              <h2 className="font-display text-lg font-semibold tracking-tight flex items-center gap-2">
                {Icon && <Icon className={cn("h-5 w-5 text-accent shrink-0", iconClassName)} />}
                {title}
              </h2>
            )}
            {description && <p className="text-sm text-muted-foreground mt-0.5">{description}</p>}
          </div>
          {(action || actions) && (
            <div className="flex shrink-0 items-center gap-2">
              {actions}
              {action && (
                <Button variant="outline" size="sm" asChild>
                  <Link href={action.href}>
                    {action.label}
                    <ArrowRight className="ml-1 h-3.5 w-3.5" />
                  </Link>
                </Button>
              )}
            </div>
          )}
        </div>
      )}
      <div className={cn(hasHeader ? "px-5 pb-5" : "p-5", contentClassName)}>{children}</div>
    </section>
  );
}
