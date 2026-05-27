import { useEffect, useRef } from "react";
import { formatDistanceToNow } from "date-fns";
import { Bell, CheckCheck, X } from "lucide-react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  useGetNotifications,
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  getGetNotificationCountQueryKey,
  getGetNotificationsQueryKey,
  type Notification,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

interface Props {
  onClose: () => void;
}

/**
 * Maps a notification's `(resourceType, resourceId)` to the URL the panel
 * should navigate to when the row is clicked. Returns `null` for resource
 * types we don't have a destination for — the row stays non-clickable (only
 * the mark-as-read side effect fires).
 *
 * Keep this list in sync with the `resourceType` values written by API-server
 * notification inserts (search the codebase for `notificationsTable`).
 */
export function resourceUrlFor(n: Notification): string | null {
  if (!n.resourceType) return null;
  switch (n.resourceType) {
    case "agent_onboarding":
      // `/admin-onboarding/:agentId` is keyed by agentId — but the writers
      // store `run.id` (not the agent's id) in resourceId, so we can't
      // deep-link to the run's detail page. Fall back to the list view,
      // which surfaces every run in flight.
      return "/admin-onboarding";
    case "agent":
      return n.resourceId ? `/agents/${n.resourceId}` : null;
    case "contact":
      return n.resourceId ? `/crm/contacts/${n.resourceId}` : null;
    case "lead":
      return "/crm";
    case "license":
      return "/licensing";
    case "certification":
      return "/certifications";
    case "deal":
      return "/crm";
    case "task":
      return "/tasks";
    case "document":
      return "/documents";
    case "org":
      // Notifications scoped to the whole org (e.g. AHIP season open) don't
      // point at a single page — surface the compliance hub which is the
      // closest landing page for these alerts.
      return "/compliance";
    case "esign_envelope":
      return n.resourceId ? `/sign/${n.resourceId}` : null;
    default:
      return null;
  }
}

export default function NotificationPanel({ onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();
  const [, setLocation] = useLocation();

  const { data: notifications = [] } = useGetNotifications({});
  const markAllRead = useMarkAllNotificationsRead();
  const markOneRead = useMarkNotificationRead();

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getGetNotificationCountQueryKey() });
    qc.invalidateQueries({ queryKey: getGetNotificationsQueryKey({}) });
  };

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  return (
    <div
      ref={panelRef}
      className="absolute right-0 top-full mt-2 w-80 rounded-xl border border-border bg-popover shadow-xl z-50"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <Bell className="h-4 w-4 text-muted-foreground" />
          <span className="font-semibold text-sm">Notifications</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted-foreground"
            onClick={() => {
              markAllRead.mutate(undefined, { onSuccess: invalidate });
            }}
          >
            <CheckCheck className="h-3.5 w-3.5 mr-1" />
            Mark all read
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onClose}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <ScrollArea className="max-h-[360px]">
        {notifications.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            <Bell className="h-8 w-8 mx-auto mb-2 opacity-30" />
            <p>No notifications yet</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {notifications.map((n) => {
              const url = resourceUrlFor(n);
              return (
                <div
                  key={n.id}
                  data-testid={`notification-row-${n.id}`}
                  className={cn(
                    "px-4 py-3 hover:bg-muted/50 transition-colors",
                    url ? "cursor-pointer" : "cursor-default",
                    !n.readAt && "bg-primary/5",
                  )}
                  onClick={() => {
                    if (!n.readAt) {
                      markOneRead.mutate(
                        { id: n.id },
                        { onSuccess: invalidate },
                      );
                    }
                    if (url) {
                      setLocation(url);
                      onClose();
                    }
                  }}
                >
                  <div className="flex items-start gap-2">
                    {!n.readAt && (
                      <div className="h-2 w-2 rounded-full bg-primary mt-1.5 shrink-0" />
                    )}
                    <div className={cn("min-w-0", !n.readAt ? "" : "pl-4")}>
                      <p className="text-sm font-medium text-foreground leading-snug">
                        {n.title}
                      </p>
                      {n.body && (
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                          {n.body}
                        </p>
                      )}
                      <p className="text-[11px] text-muted-foreground/70 mt-1">
                        {formatDistanceToNow(new Date(n.createdAt), {
                          addSuffix: true,
                        })}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
