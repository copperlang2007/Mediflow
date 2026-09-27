import type { ReactNode } from "react";
import { useGetMe } from "@workspace/api-client-react";
import { ChevronRight, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";

/** Roles that manage the install and may see server-side setup details. */
const TECHNICAL_ROLES = new Set(["super_admin", "agency_admin", "developer"]);

/** True when the signed-in user may see setup details (env vars, code names). */
export function useCanSeeTechnicalDetails(): boolean {
  const { data: me } = useGetMe();
  return Boolean(me?.role && TECHNICAL_ROLES.has(me.role));
}

/**
 * A collapsed "Technical details" disclosure for admins only.
 *
 * Page copy stays in plain language for agents; environment variable names,
 * file paths and internal identifiers go in here so whoever runs the install
 * still has what they need. Renders nothing for other roles.
 */
export function TechnicalDetails({
  children,
  className,
  label = "Technical details",
}: {
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  const allowed = useCanSeeTechnicalDetails();
  if (!allowed) return null;
  return (
    <details className={cn("group mt-2 text-xs text-muted-foreground", className)}>
      <summary className="inline-flex cursor-pointer select-none items-center gap-1 font-medium hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
        <Wrench className="h-3 w-3" />
        {label}
        <span className="font-normal">(admins only)</span>
      </summary>
      <div className="mt-1.5 rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-[11px] leading-relaxed break-words">
        {children}
      </div>
    </details>
  );
}
