import { useState } from "react";
import {
  useGetAgentTasks,
  useCreateTask,
  getGetAgentTasksQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { CheckSquare, Plus } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

export default function TasksTab({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const { data: tasksData, isLoading } = useGetAgentTasks(agentId);
  const tasks = tasksData?.data;
  const { mutateAsync: createTask, isPending: creating } = useCreateTask();

  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState<{
    title: string;
    description: string;
    dueDate: string;
    priority: "low" | "medium" | "high" | "urgent";
  }>({ title: "", description: "", dueDate: "", priority: "medium" });

  const PRIORITY_STYLES: Record<string, string> = {
    urgent: "bg-red-100 text-red-800",
    high: "bg-orange-100 text-orange-800",
    medium: "bg-amber-100 text-amber-800",
    low: "bg-slate-100 text-slate-600",
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) return;
    try {
      await createTask({
        data: {
          agentId,
          title: form.title.trim(),
          description: form.description.trim() || undefined,
          dueDate: form.dueDate || undefined,
          priority: form.priority,
        },
      });
      toast.success("Task assigned to agent");
      void qc.invalidateQueries({ queryKey: getGetAgentTasksQueryKey(agentId) });
      void qc.invalidateQueries({ queryKey: ["/api/tasks"] });
      void qc.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
      setForm({ title: "", description: "", dueDate: "", priority: "medium" });
      setAddOpen(false);
    } catch {
      toast.error("Failed to assign task");
    }
  };

  if (isLoading) return <div className="p-6"><Skeleton className="h-40 w-full" /></div>;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{tasks?.length ?? 0} task{tasks?.length !== 1 ? "s" : ""}</p>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4 mr-1.5" />
          New task
        </Button>
      </div>
      {(tasks ?? []).length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <CheckSquare className="h-10 w-10 mx-auto mb-2 opacity-20" />
          <p className="text-sm">No tasks assigned</p>
        </div>
      ) : (
        <div className="space-y-2">
          {(tasks ?? []).map((task) => (
            <div key={task.id} className="flex items-center gap-3 rounded-lg border border-border px-4 py-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{task.title}</p>
                {task.dueDate && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Due {format(new Date(task.dueDate), "MMM d, yyyy")}
                  </p>
                )}
              </div>
              <Badge variant="secondary" className={`text-xs ${PRIORITY_STYLES[task.priority] ?? ""}`}>
                {task.priority}
              </Badge>
              <Badge variant="secondary" className="text-xs capitalize">
                {task.status.replace("_", " ")}
              </Badge>
            </div>
          ))}
        </div>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assign task to this agent</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="task-title">Title</Label>
              <Input
                id="task-title"
                value={form.title}
                onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
                placeholder="e.g. Renew Texas Health license"
                autoFocus
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="task-desc">Description</Label>
              <Input
                id="task-desc"
                value={form.description}
                onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
                placeholder="Optional details"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="task-due">Due date</Label>
                <Input
                  id="task-due"
                  type="date"
                  value={form.dueDate}
                  onChange={(e) => setForm((p) => ({ ...p, dueDate: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="task-priority">Priority</Label>
                <Select
                  value={form.priority}
                  onValueChange={(v) =>
                    setForm((p) => ({ ...p, priority: v as typeof form.priority }))
                  }
                >
                  <SelectTrigger id="task-priority">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="urgent">Urgent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={creating || !form.title.trim()}>
                {creating ? "Assigning…" : "Assign task"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
