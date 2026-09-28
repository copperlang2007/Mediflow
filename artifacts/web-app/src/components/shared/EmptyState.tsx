import type { ComponentType, ReactNode } from "react";
import { Link } from "wouter";
import { Inbox } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Friendly "nothing here yet" block. Write the copy in plain words: say what
 * would appear here and what the person can do next.
 *
 *   <EmptyState title="No tasks due"
 *               description="When a task is assigned to you, it shows up here."
 *               action={{ label: "Create a task", href: "/tasks" }} />
 */
export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  children,
  compact = false,
  className,
}: {
  icon?: ComponentType<{ className?: string }>;
  title: ReactNode;
  description?: ReactNode;
  action?: { label: string; href?: string; onClick?: () => void };
  /** Extra content (e.g. several buttons) under the description. */
  children?: ReactNode;
  /** Less padding, for use inside small cards. */
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "py-6 px-4" : "py-12 px-6",
        className,
      )}
    >
      <div
        className={cn(
          "flex items-center justify-center rounded-2xl bg-muted text-accent mb-3",
          compact ? "h-10 w-10" : "h-14 w-14",
        )}
      >
        <Icon className={compact ? "h-5 w-5" : "h-7 w-7"} />
      </div>
      <p className={cn("font-display font-semibold text-foreground", compact ? "text-sm" : "text-base")}>
        {title}
      </p>
      {description && (
        <p className={cn("mt-1 max-w-sm text-muted-foreground", compact ? "text-xs" : "text-sm")}>
          {description}
        </p>
      )}
      {action && (
        <div className="mt-4">
          {action.href ? (
            <Button size="sm" asChild>
              <Link href={action.href}>{action.label}</Link>
            </Button>
          ) : (
            <Button size="sm" onClick={action.onClick}>
              {action.label}
            </Button>
          )}
        </div>
      )}
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}
