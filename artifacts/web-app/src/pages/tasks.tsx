import { useState } from "react";
import {
  useGetTasks,
  useCreateTask,
  useUpdateTask,
  useGetTaskTemplates,
  useCreateTaskTemplate,
  useUpdateTaskTemplate,
  useDeleteTaskTemplate,
  getGetTaskTemplatesQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { CheckSquare, Plus, Search, Filter, Clock, FileText, Zap, Pencil, Trash2, LayoutTemplate, ListChecks } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import type { TaskTemplate, TaskTemplatePriority } from "@workspace/api-client-react";

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

const TEMPLATE_TYPE_LABELS: Record<string, string> = {
  custom: "Custom",
  onboarding: "Onboarding",
  offboarding: "Offboarding",
  renewal: "Renewal",
  compliance: "Compliance",
};

const TRIGGER_EVENT_LABELS: Record<string, string> = {
  agent_created: "Agent Created",
  agent_offboarded: "Agent Offboarded",
  license_expiry_30: "License Expiring (30d)",
  cert_expiry_30: "Certification Expiring (30d)",
  ahip_due: "AHIP Due",
  manual: "Manual Only",
};

type View = "tasks" | "templates";

function TemplateFormDialog({
  open,
  onClose,
  template,
}: {
  open: boolean;
  onClose: () => void;
  template?: TaskTemplate | null;
}) {
  const qc = useQueryClient();
  const { mutateAsync: createTemplate, isPending: creating } = useCreateTaskTemplate();
  const { mutateAsync: updateTemplate, isPending: updating } = useUpdateTaskTemplate();

  const [form, setForm] = useState({
    name: template?.name ?? "",
    title: template?.title ?? "",
    description: template?.description ?? "",
    type: template?.type ?? "custom",
    priority: template?.priority ?? "medium",
    triggerEvent: template?.triggerEvent ?? "",
    dueDaysFromTrigger: template?.dueDaysFromTrigger != null ? String(template.dueDaysFromTrigger) : "",
  });

  const isEditing = !!template;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const payload = {
        name: form.name,
        title: form.title,
        description: form.description || undefined,
        type: form.type,
        priority: form.priority as "low" | "medium" | "high" | "urgent",
        triggerEvent: form.triggerEvent || undefined,
        dueDaysFromTrigger: form.dueDaysFromTrigger ? parseInt(form.dueDaysFromTrigger, 10) : undefined,
      };

      if (isEditing) {
        await updateTemplate({ id: template!.id, data: payload });
        toast.success("Template updated");
      } else {
        await createTemplate({ data: payload });
        toast.success("Template created");
      }
      void qc.invalidateQueries({ queryKey: getGetTaskTemplatesQueryKey() });
      onClose();
    } catch {
      toast.error(isEditing ? "Failed to update template" : "Failed to create template");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Template" : "New Task Template"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5 col-span-2">
              <Label>Template Name *</Label>
              <Input
                placeholder="e.g. New Agent Onboarding"
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                required
              />
              <p className="text-xs text-muted-foreground">Internal name for identifying this template</p>
            </div>
            <div className="space-y-1.5 col-span-2">
              <Label>Task Title *</Label>
              <Input
                placeholder="e.g. Complete state license application"
                value={form.title}
                onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
                required
              />
              <p className="text-xs text-muted-foreground">Default title shown when a task is created from this template</p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Description</Label>
            <Textarea
              placeholder="Detailed instructions for this task…"
              value={form.description}
              onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
              rows={3}
              className="resize-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select value={form.type} onValueChange={(v) => setForm((p) => ({ ...p, type: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(TEMPLATE_TYPE_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Default Priority</Label>
              <Select value={form.priority} onValueChange={(v) => setForm((p) => ({ ...p, priority: v as TaskTemplatePriority }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["low", "medium", "high", "urgent"].map((p) => (
                    <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="rounded-lg border border-border p-3 space-y-3 bg-muted/30">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Automation Trigger</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Trigger Event</Label>
                <Select value={form.triggerEvent || "_none"} onValueChange={(v) => setForm((p) => ({ ...p, triggerEvent: v === "_none" ? "" : v }))}>
                  <SelectTrigger><SelectValue placeholder="No trigger" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_none">No trigger (manual only)</SelectItem>
                    {Object.entries(TRIGGER_EVENT_LABELS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Due Days After Trigger</Label>
                <Input
                  type="number"
                  placeholder="e.g. 7"
                  min={0}
                  max={365}
                  value={form.dueDaysFromTrigger}
                  onChange={(e) => setForm((p) => ({ ...p, dueDaysFromTrigger: e.target.value }))}
                  disabled={!form.triggerEvent}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              When the trigger event fires, a task will be automatically created and due in the specified number of days.
            </p>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={creating || updating || !form.name || !form.title}>
              {creating || updating ? "Saving…" : isEditing ? "Save Changes" : "Create Template"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreateTaskFromTemplateDialog({
  open,
  onClose,
  templates,
}: {
  open: boolean;
  onClose: () => void;
  templates: TaskTemplate[];
}) {
  const qc = useQueryClient();
  const { mutateAsync: createTask, isPending } = useCreateTask();
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [dueDate, setDueDate] = useState("");

  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTemplate) return;
    try {
      await createTask({
        data: {
          title: selectedTemplate.title,
          description: selectedTemplate.description ?? undefined,
          priority: selectedTemplate.priority as "low" | "medium" | "high" | "urgent",
          templateId: selectedTemplate.id,
          dueDate: dueDate || undefined,
        },
      });
      toast.success("Task created from template");
      void qc.invalidateQueries({ queryKey: ["getTasks"] });
      onClose();
      setSelectedTemplateId("");
      setDueDate("");
    } catch {
      toast.error("Failed to create task");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { onClose(); setSelectedTemplateId(""); setDueDate(""); } }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Create Task from Template</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label>Template *</Label>
            <Select value={selectedTemplateId} onValueChange={setSelectedTemplateId}>
              <SelectTrigger><SelectValue placeholder="Select a template…" /></SelectTrigger>
              <SelectContent>
                {templates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {selectedTemplate && (
            <div className="rounded-lg bg-muted/40 border border-border p-3 space-y-1">
              <p className="text-xs font-semibold">{selectedTemplate.title}</p>
              {selectedTemplate.description && (
                <p className="text-xs text-muted-foreground line-clamp-2">{selectedTemplate.description}</p>
              )}
              <div className="flex items-center gap-2 mt-1.5">
                <Badge variant="secondary" className={cn("text-[10px]", PRIORITY_STYLES[selectedTemplate.priority])}>
                  {selectedTemplate.priority}
                </Badge>
                <Badge variant="secondary" className="text-[10px] bg-slate-100 text-slate-600 capitalize">
                  {TEMPLATE_TYPE_LABELS[selectedTemplate.type] ?? selectedTemplate.type}
                </Badge>
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Due Date</Label>
            {selectedTemplate?.dueDaysFromTrigger ? (
              <p className="text-xs text-muted-foreground">
                Default: {selectedTemplate.dueDaysFromTrigger} days from today —{" "}
                {format(new Date(Date.now() + selectedTemplate.dueDaysFromTrigger * 86400000), "MMM d, yyyy")}
              </p>
            ) : null}
            <Input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => { onClose(); setSelectedTemplateId(""); setDueDate(""); }}>Cancel</Button>
            <Button type="submit" disabled={isPending || !selectedTemplateId}>
              {isPending ? "Creating…" : "Create Task"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TasksView() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [fromTemplateOpen, setFromTemplateOpen] = useState(false);
  const [form, setForm] = useState({ title: "", description: "", dueDate: "", priority: "medium" as string });

  const { data, isLoading } = useGetTasks({ status: statusFilter === "all" ? undefined : statusFilter, limit: 100 });
  const { data: templates } = useGetTaskTemplates();
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
    } catch {
      toast.error("Failed to create task");
    }
  };

  const counts = {
    open: (data?.tasks ?? []).filter((t) => t.status === "open").length,
    in_progress: (data?.tasks ?? []).filter((t) => t.status === "in_progress").length,
    completed: (data?.tasks ?? []).filter((t) => t.status === "completed").length,
  };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Open", value: counts.open, style: "bg-blue-50 border-blue-100", textStyle: "text-blue-700" },
          { label: "In Progress", value: counts.in_progress, style: "bg-amber-50 border-amber-100", textStyle: "text-amber-700" },
          { label: "Completed", value: counts.completed, style: "bg-green-50 border-green-100", textStyle: "text-green-700" },
        ].map((stat) => (
          <div key={stat.label} className={cn("rounded-lg border p-3", stat.style)}>
            <p className={cn("text-2xl font-bold", stat.textStyle)}>{stat.value}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{stat.label}</p>
          </div>
        ))}
      </div>

      <div className="flex gap-2 flex-wrap items-center">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search tasks…" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
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
        <div className="flex gap-2 ml-auto">
          {(templates ?? []).length > 0 && (
            <Button size="sm" variant="outline" onClick={() => setFromTemplateOpen(true)}>
              <LayoutTemplate className="h-3.5 w-3.5 mr-1.5" />
              From Template
            </Button>
          )}
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4 mr-1.5" />
            New Task
          </Button>
        </div>
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
              <div className="flex justify-center gap-2 mt-4">
                {(templates ?? []).length > 0 && (
                  <Button size="sm" variant="outline" onClick={() => setFromTemplateOpen(true)}>
                    <LayoutTemplate className="h-4 w-4 mr-1.5" />
                    From Template
                  </Button>
                )}
                <Button size="sm" onClick={() => setAddOpen(true)}>
                  <Plus className="h-4 w-4 mr-1.5" />
                  Create Task
                </Button>
              </div>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {filtered.map((task) => (
                <div key={task.id} className="flex items-start gap-3 px-4 py-3 hover:bg-muted/40 transition-colors">
                  <button
                    className={cn(
                      "h-5 w-5 rounded-full border-2 shrink-0 mt-0.5 flex items-center justify-center transition-colors",
                      task.status === "completed"
                        ? "bg-green-500 border-green-500"
                        : "border-muted-foreground/30 hover:border-primary",
                    )}
                    onClick={async () => {
                      const newStatus = task.status === "completed" ? "open" : "completed";
                      try {
                        await updateTask({ id: task.id, data: { status: newStatus } });
                        void qc.invalidateQueries({ queryKey: ["getTasks"] });
                      } catch {
                        toast.error("Failed to update");
                      }
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
                    {task.description && (
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{task.description}</p>
                    )}
                    {task.dueDate && (
                      <p className={cn(
                        "text-xs flex items-center gap-1 mt-0.5",
                        new Date(task.dueDate) < new Date() && task.status !== "completed"
                          ? "text-red-600"
                          : "text-muted-foreground"
                      )}>
                        <Clock className="h-3 w-3" />
                        Due {format(new Date(task.dueDate), "MMM d, yyyy")}
                        {new Date(task.dueDate) < new Date() && task.status !== "completed" && " · Overdue"}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Badge variant="secondary" className={`text-xs ${PRIORITY_STYLES[task.priority] ?? ""}`}>
                      {task.priority}
                    </Badge>
                    <Badge variant="secondary" className={`text-xs capitalize ${STATUS_STYLES[task.status] ?? ""}`}>
                      {task.status.replace("_", " ")}
                    </Badge>
                  </div>
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
              <Input placeholder="Task description…" value={form.title} onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))} required />
            </div>
            <div className="space-y-1.5">
              <Label>Description</Label>
              <Textarea placeholder="Additional details…" value={form.description} onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))} rows={2} className="resize-none" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Due Date</Label>
                <Input type="date" value={form.dueDate} onChange={(e) => setForm((p) => ({ ...p, dueDate: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label>Priority</Label>
                <Select value={form.priority} onValueChange={(v) => setForm((p) => ({ ...p, priority: v }))}>
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

      <CreateTaskFromTemplateDialog
        open={fromTemplateOpen}
        onClose={() => setFromTemplateOpen(false)}
        templates={templates ?? []}
      />
    </div>
  );
}

function TemplatesView() {
  const qc = useQueryClient();
  const { data: templates, isLoading } = useGetTaskTemplates();
  const { mutateAsync: updateTemplate } = useUpdateTaskTemplate();
  const { mutateAsync: deleteTemplate } = useDeleteTaskTemplate();

  const [formOpen, setFormOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<TaskTemplate | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const handleToggleActive = async (template: TaskTemplate) => {
    try {
      await updateTemplate({ id: template.id, data: { isActive: !template.isActive } });
      void qc.invalidateQueries({ queryKey: getGetTaskTemplatesQueryKey() });
      toast.success(template.isActive ? "Template deactivated" : "Template activated");
    } catch {
      toast.error("Failed to update template");
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      await deleteTemplate({ id: deleteId });
      void qc.invalidateQueries({ queryKey: getGetTaskTemplatesQueryKey() });
      toast.success("Template deleted");
      setDeleteId(null);
    } catch {
      toast.error("Failed to delete template");
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground">
            {templates?.length ?? 0} template{templates?.length !== 1 ? "s" : ""} defined
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Templates define reusable task structures with optional automation triggers
          </p>
        </div>
        <Button size="sm" onClick={() => { setEditingTemplate(null); setFormOpen(true); }}>
          <Plus className="h-4 w-4 mr-1.5" />
          New Template
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-20 w-full" />)}
        </div>
      ) : (templates ?? []).length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <LayoutTemplate className="h-12 w-12 mx-auto mb-3 text-muted-foreground/30" />
            <p className="text-sm font-medium text-muted-foreground">No templates yet</p>
            <p className="text-xs text-muted-foreground mt-1 mb-4">
              Create templates to standardize tasks across agents and automate task creation.
            </p>
            <Button size="sm" onClick={() => { setEditingTemplate(null); setFormOpen(true); }}>
              <Plus className="h-4 w-4 mr-1.5" />
              Create First Template
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {(templates ?? []).map((template) => (
            <Card key={template.id} className={cn(!template.isActive && "opacity-60")}>
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-semibold">{template.name}</p>
                      <Badge variant="secondary" className={cn("text-[10px]", PRIORITY_STYLES[template.priority])}>
                        {template.priority}
                      </Badge>
                      <Badge variant="secondary" className="text-[10px] bg-slate-100 text-slate-600 capitalize">
                        {TEMPLATE_TYPE_LABELS[template.type] ?? template.type}
                      </Badge>
                      {!template.isActive && (
                        <Badge variant="secondary" className="text-[10px] bg-slate-100 text-slate-500">
                          Inactive
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">{template.title}</p>
                    {template.description && (
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{template.description}</p>
                    )}
                    {template.triggerEvent && (
                      <div className="flex items-center gap-1.5 mt-2">
                        <Zap className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                        <span className="text-xs text-muted-foreground">
                          Auto-trigger: {TRIGGER_EVENT_LABELS[template.triggerEvent] ?? template.triggerEvent}
                          {template.dueDaysFromTrigger != null && ` · due in ${template.dueDaysFromTrigger}d`}
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => handleToggleActive(template)}
                      title={template.isActive ? "Deactivate" : "Activate"}
                    >
                      {template.isActive ? "Deactivate" : "Activate"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 text-muted-foreground"
                      onClick={() => { setEditingTemplate(template); setFormOpen(true); }}
                      title="Edit template"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                      onClick={() => setDeleteId(template.id)}
                      title="Delete template"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <TemplateFormDialog
        open={formOpen}
        onClose={() => { setFormOpen(false); setEditingTemplate(null); }}
        template={editingTemplate}
      />

      <AlertDialog open={!!deleteId} onOpenChange={(v) => { if (!v) setDeleteId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this template?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the template. Existing tasks created from it will not be affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={handleDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default function TasksPage() {
  const [view, setView] = useState<View>("tasks");

  return (
    <div className="p-6 space-y-5 max-w-5xl mx-auto">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Tasks</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Task management and onboarding checklists</p>
        </div>
        <div className="flex rounded-lg border border-border overflow-hidden shrink-0">
          <button
            onClick={() => setView("tasks")}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 text-sm transition-colors",
              view === "tasks" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
            )}
          >
            <ListChecks className="h-4 w-4" />
            Tasks
          </button>
          <button
            onClick={() => setView("templates")}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 text-sm transition-colors",
              view === "templates" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
            )}
          >
            <LayoutTemplate className="h-4 w-4" />
            Templates
          </button>
        </div>
      </div>

      {view === "tasks" ? <TasksView /> : <TemplatesView />}
    </div>
  );
}
