import { useState } from "react";
import { useGetTasks, useCreateTask, useUpdateTask } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { CheckSquare, Plus, Search, Filter, Clock } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<string, string> = {
  open: "bg-blue-100 text-blue-800",
  in_progress: "bg-amber-100 text-amber-800",
  completed: "bg-green-100 text-green-800",
  cancelled: "bg-slate-100 text-slate-600",
};

const PRIORITY_STYLES: Record<string, string> = {
  urgent: "bg-red-100 text-red-800",
  high: "bg-orange-100 text-orange-800",
  medium: "bg-amber-100 text-amber-800",
  low: "bg-slate-100 text-slate-600",
};

export default function TasksPage() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ title: "", description: "", dueDate: "", priority: "medium" as string });

  const { data, isLoading } = useGetTasks({
    status: statusFilter === "all" ? undefined : statusFilter,
    limit: 100,
  });

  const { mutateAsync: createTask, isPending } = useCreateTask();
  const { mutateAsync: updateTask } = useUpdateTask();

  const filtered = (data?.tasks ?? []).filter((t) => {
    if (!search) return true;
    return t.title.toLowerCase().includes(search.toLowerCase());
  });

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await createTask({ data: { title: form.title, description: form.description || undefined, dueDate: form.dueDate || undefined, priority: form.priority as "low" | "medium" | "high" | "urgent" } });
      toast.success("Task created");
      void qc.invalidateQueries({ queryKey: ["getTasks"] });
      setAddOpen(false);
      setForm({ title: "", description: "", dueDate: "", priority: "medium" });
    } catch { toast.error("Failed to create task"); }
  };

  return (
    <div className="p-6 space-y-5 max-w-5xl mx-auto">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Tasks</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Task management and onboarding checklists</p>
        </div>
        <Button onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          New Task
        </Button>
      </div>

      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search tasks…"
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40">
            <Filter className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="in_progress">In Progress</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-16 text-center">
              <CheckSquare className="h-12 w-12 mx-auto mb-3 text-muted-foreground/30" />
              <p className="text-sm font-medium text-muted-foreground">No tasks found</p>
              <Button className="mt-4" size="sm" onClick={() => setAddOpen(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Create Task
              </Button>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {filtered.map((task) => (
                <div key={task.id} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors">
                  <button
                    className={cn(
                      "h-5 w-5 rounded-full border-2 shrink-0 flex items-center justify-center transition-colors",
                      task.status === "completed"
                        ? "bg-green-500 border-green-500"
                        : "border-muted-foreground/30 hover:border-primary"
                    )}
                    onClick={async () => {
                      const newStatus = task.status === "completed" ? "open" : "completed";
                      try {
                        await updateTask({ id: task.id, data: { status: newStatus } });
                        void qc.invalidateQueries({ queryKey: ["getTasks"] });
                      } catch { toast.error("Failed to update"); }
                    }}
                  >
                    {task.status === "completed" && (
                      <svg className="h-3 w-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </button>
                  <div className="flex-1 min-w-0">
                    <p className={cn("text-sm font-medium", task.status === "completed" && "line-through text-muted-foreground")}>
                      {task.title}
                    </p>
                    {task.dueDate && (
                      <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                        <Clock className="h-3 w-3" />
                        Due {format(new Date(task.dueDate), "MMM d, yyyy")}
                      </p>
                    )}
                  </div>
                  <Badge variant="secondary" className={`text-xs ${PRIORITY_STYLES[task.priority] ?? ""}`}>
                    {task.priority}
                  </Badge>
                  <Badge variant="secondary" className={`text-xs capitalize ${STATUS_STYLES[task.status] ?? ""}`}>
                    {task.status.replace("_", " ")}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {data && <p className="text-xs text-muted-foreground text-center">{data.total} total tasks</p>}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>New Task</DialogTitle></DialogHeader>
          <form onSubmit={handleCreate} className="space-y-3">
            <div className="space-y-1.5">
              <Label>Title *</Label>
              <Input placeholder="Task description…" value={form.title} onChange={(e) => setForm(p => ({ ...p, title: e.target.value }))} required />
            </div>
            <div className="space-y-1.5">
              <Label>Description</Label>
              <Input placeholder="Additional details…" value={form.description} onChange={(e) => setForm(p => ({ ...p, description: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Due Date</Label>
                <Input type="date" value={form.dueDate} onChange={(e) => setForm(p => ({ ...p, dueDate: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label>Priority</Label>
                <Select value={form.priority} onValueChange={(v) => setForm(p => ({ ...p, priority: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {["low", "medium", "high", "urgent"].map((p) => (
                      <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={isPending || !form.title}>Create Task</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
