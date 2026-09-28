import type { ReactNode } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { initials } from "./shared";

/** Navy initials circle used for people across the CRM (agencyBRIDGE look). */
export function ContactAvatar({
  first,
  last,
  size = "md",
  className,
}: {
  first?: string | null;
  last?: string | null;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}) {
  const sizeClass =
    size === "sm" ? "h-8 w-8 text-[11px]"
      : size === "lg" ? "h-12 w-12 text-sm"
        : size === "xl" ? "h-16 w-16 text-lg"
          : "h-9 w-9 text-xs";
  return (
    <Avatar className={cn("shrink-0", sizeClass, className)}>
      <AvatarFallback className="bg-navy-100 text-navy-800 font-semibold dark:bg-secondary dark:text-secondary-foreground">
        {initials(first ?? "", last ?? "") || "?"}
      </AvatarFallback>
    </Avatar>
  );
}

/**
 * White rounded panel holding a toolbar (search + filters) on top and a list
 * or table underneath — the "Clients & Leads" table card from agencyBRIDGE.
 */
export function ListCard({
  toolbar,
  children,
  className,
}: {
  toolbar?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-xl border border-border bg-card text-card-foreground shadow-sm", className)}>
      {toolbar && <div className="flex flex-col gap-3 p-4 md:flex-row md:items-center">{toolbar}</div>}
      <div className={cn(toolbar ? "px-4 pb-4" : "p-4")}>{children}</div>
    </section>
  );
}

/** Table header cell with the muted agencyBRIDGE styling. */
export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <th className={cn("px-4 py-3 text-left text-xs font-semibold text-muted-foreground whitespace-nowrap", className)}>
      {children}
    </th>
  );
}
