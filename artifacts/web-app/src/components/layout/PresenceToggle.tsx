/**
 * Agent presence toggle — the sidebar control an agent uses to mark themselves
 * Available / Away for inbound lead routing.
 *
 * Rendered only for the `agent` role (see AppShell). It drives
 * `usePresenceHeartbeat`, which keeps the server-side `agent_presence` row
 * fresh; the ready-to-sell router only offers inbound calls to agents who are
 * currently Available. If the user has no linked agent record (the heartbeat
 * 404s), the control hides itself.
 */
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  usePresenceHeartbeat,
  type PresenceUiStatus,
} from "@/hooks/usePresenceHeartbeat";

const LABEL: Record<PresenceUiStatus, string> = {
  available: "Available",
  away: "Away",
};

export function PresenceToggle({ collapsed }: { collapsed: boolean }) {
  const { status, linked, syncing, setStatus } = usePresenceHeartbeat(true);

  // No agent record linked to this user → nothing to toggle.
  if (!linked) return null;

  const available = status === "available";
  const toggle = () => setStatus(available ? "away" : "available");
  const label = LABEL[status];

  const dot = (
    <span
      className={cn(
        "h-2.5 w-2.5 rounded-full shrink-0 transition-colors",
        available ? "bg-emerald-500" : "bg-muted-foreground/40",
        syncing && "animate-pulse",
      )}
    />
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={toggle}
            aria-label={`Presence: ${label}. Click to set ${
              available ? "Away" : "Available"
            }.`}
            className="flex h-10 w-10 items-center justify-center rounded-lg hover:bg-sidebar-accent transition-colors"
          >
            {dot}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" className="font-medium">
          {label} — click to set {available ? "Away" : "Available"}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Presence: ${label}. Click to set ${
        available ? "Away" : "Available"
      }.`}
      className="flex items-center gap-2 w-full rounded-lg px-3 h-10 hover:bg-sidebar-accent transition-colors"
    >
      {dot}
      <span className="text-sm text-sidebar-foreground truncate">{label}</span>
      <span className="ml-auto text-[11px] text-sidebar-foreground/50 shrink-0">
        {available ? "On" : "Off"}
      </span>
    </button>
  );
}
