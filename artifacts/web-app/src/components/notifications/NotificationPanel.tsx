import { useEffect, useRef } from "react";
import { formatDistanceToNow } from "date-fns";
import { Bell, CheckCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  useGetNotifications,
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  getGetNotificationCountQueryKey,
  getGetNotificationsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

interface Props {
  onClose: () => void;
}

export default function NotificationPanel({ onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();

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
            {notifications.map((n) => (
              <div
                key={n.id}
                className={cn(
                  "px-4 py-3 hover:bg-muted/50 transition-colors cursor-pointer",
                  !n.readAt && "bg-primary/5"
                )}
                onClick={() => {
                  if (!n.readAt) {
                    markOneRead.mutate({ id: n.id }, { onSuccess: invalidate });
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
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
