import { useState } from "react";
import {
  useGetAgentChecklists,
  useGetAgentChecklist,
  useUpdateChecklistItem,
  getGetAgentChecklistQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { CheckSquare, Check, SkipForward } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export default function ChecklistTab({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const { data: runs, isLoading } = useGetAgentChecklists(agentId);
  const { mutateAsync: updateItem } = useUpdateChecklistItem();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const activeRun = selectedRunId ?? (runs?.[0]?.id ?? null);

  const { data: runDetail } = useGetAgentChecklist(agentId, activeRun ?? "", {
    query: { enabled: !!activeRun, queryKey: ["getAgentChecklist", agentId, activeRun ?? ""] },
  });

  const handleItemUpdate = async (runId: string, itemId: string, status: "completed" | "skipped" | "pending") => {
    try {
      await updateItem({ runId, itemId, data: { status } });
      void qc.invalidateQueries({ queryKey: getGetAgentChecklistQueryKey(agentId, runId) });
    } catch { toast.error("Failed to update item"); }
  };

  if (isLoading) return <div className="p-6"><Skeleton className="h-40 w-full" /></div>;

  if ((runs ?? []).length === 0) {
    return (
      <div className="p-6 text-center py-12 text-muted-foreground">
        <CheckSquare className="h-10 w-10 mx-auto mb-2 opacity-20" />
        <p className="text-sm">No checklists found</p>
        <p className="text-xs mt-1">An onboarding checklist is created automatically when an agent is added</p>
      </div>
    );
  }

  const items = runDetail?.items ?? [];
  const completedCount = items.filter((i) => i.status === "completed").length;
  const totalCount = items.length;

  return (
    <div className="p-6 space-y-4">
      {(runs ?? []).length > 1 && (
        <div className="flex gap-2 flex-wrap">
          {(runs ?? []).map((run) => (
            <button
              key={run.id}
              onClick={() => setSelectedRunId(run.id)}
              className={cn(
                "text-xs px-3 py-1.5 rounded-full border transition-colors capitalize",
                (activeRun === run.id)
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border text-muted-foreground hover:bg-muted"
              )}
            >
              {run.type} · {run.status}
            </button>
          ))}
        </div>
      )}

      {runDetail && (
        <>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold capitalize">{runDetail.type} Checklist</p>
              <p className="text-xs text-muted-foreground">{completedCount}/{totalCount} items complete</p>
            </div>
            <Badge
              variant="secondary"
              className={runDetail.status === "completed" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"}
            >
              {runDetail.status === "completed" ? "Complete" : "In Progress"}
            </Badge>
          </div>
          <Progress value={totalCount > 0 ? (completedCount / totalCount) * 100 : 0} className="h-1.5" />
          <div className="space-y-2">
            {items.map((item) => (
              <div
                key={item.id}
                className={cn(
                  "flex items-start gap-3 rounded-lg border px-4 py-3 transition-colors",
                  item.status === "completed" ? "border-green-200 bg-green-50/50" :
                  item.status === "skipped" ? "border-slate-200 bg-slate-50/50 opacity-60" :
                  "border-border"
                )}
              >
                <div className={cn(
                  "mt-0.5 flex-shrink-0 h-5 w-5 rounded-full border-2 flex items-center justify-center",
                  item.status === "completed" ? "bg-green-500 border-green-500 text-white" :
                  item.status === "skipped" ? "bg-slate-200 border-slate-200" :
                  "border-muted-foreground/30"
                )}>
                  {item.status === "completed" && <Check className="h-3 w-3" />}
                  {item.status === "skipped" && <SkipForward className="h-3 w-3 text-slate-400" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className={cn("text-sm", item.status === "completed" && "line-through text-muted-foreground")}>
                    {item.title}
                    {item.required && item.status !== "completed" && (
                      <span className="ml-1 text-xs text-red-500">*</span>
                    )}
                  </p>
                  {item.description && <p className="text-xs text-muted-foreground mt-0.5">{item.description}</p>}
                </div>
                {runDetail.status !== "completed" && item.status === "pending" && (
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-xs text-green-700 border-green-200 hover:bg-green-50"
                      onClick={() => handleItemUpdate(runDetail.id, item.id, "completed")}
                    >
                      <Check className="h-3 w-3 mr-1" />Done
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs text-muted-foreground"
                      onClick={() => handleItemUpdate(runDetail.id, item.id, "skipped")}
                    >
                      Skip
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
