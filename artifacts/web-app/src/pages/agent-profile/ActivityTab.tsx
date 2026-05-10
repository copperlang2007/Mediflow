import { useGetAuditLog } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { FileText } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";

export default function ActivityTab({ agentId }: { agentId: string }) {
  const { data, isLoading } = useGetAuditLog({ limit: 100 });

  const entries = (data?.entries ?? []).filter(
    (e) =>
      e.resourceId === agentId ||
      (e.changes && typeof e.changes === "object" && "agentId" in e.changes && (e.changes as Record<string, unknown>).agentId === agentId)
  );

  const ACTION_STYLES: Record<string, string> = {
    create: "bg-green-100 text-green-800",
    update: "bg-blue-100 text-blue-800",
    delete: "bg-red-100 text-red-800",
    offboard: "bg-orange-100 text-orange-800",
    complete: "bg-green-100 text-green-800",
  };

  if (isLoading) return <div className="p-6"><Skeleton className="h-40 w-full" /></div>;

  return (
    <div className="p-6 space-y-4">
      <p className="text-sm text-muted-foreground">{entries.length} event{entries.length !== 1 ? "s" : ""}</p>
      {entries.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <FileText className="h-10 w-10 mx-auto mb-2 opacity-20" />
          <p className="text-sm">No activity recorded</p>
        </div>
      ) : (
        <div className="relative border-l-2 border-border ml-3 space-y-0">
          {entries.map((entry) => {
            const actionKey = entry.action?.split(".").pop() ?? entry.action ?? "";
            const badgeStyle = ACTION_STYLES[actionKey] ?? "bg-slate-100 text-slate-600";
            return (
              <div key={entry.id} className="relative pl-6 pb-5 last:pb-0">
                <span className="absolute -left-1.5 top-1.5 h-3 w-3 rounded-full bg-border border-2 border-background" />
                <div className="flex items-start gap-2 flex-wrap">
                  <Badge variant="secondary" className={cn("text-[10px] px-1.5 py-0 capitalize", badgeStyle)}>
                    {entry.action}
                  </Badge>
                  {entry.resourceType && (
                    <span className="text-xs text-muted-foreground capitalize">{entry.resourceType.replace(/_/g, " ")}</span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {format(new Date(entry.createdAt), "MMM d, yyyy 'at' h:mm a")}
                  {entry.userId && <span className="ml-2">· by user</span>}
                </p>
                {entry.changes && Object.keys(entry.changes).length > 0 && (
                  <p className="text-xs text-muted-foreground mt-0.5 font-mono truncate">
                    {JSON.stringify(entry.changes).slice(0, 120)}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
