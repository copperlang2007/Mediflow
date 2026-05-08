import { useState, useMemo, useRef } from "react";
import {
  useGetAgents,
  useCreateAgent,
  useGetAgentComplianceScore,
  useGetUsers,
  useGetTaskTemplates,
  getGetAgentsQueryKey,
  customFetch,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Label } from "@/components/ui/label";
import {
  Users, Plus, Search, Filter, ChevronRight, Download,
  ChevronsUpDown, ChevronUp, ChevronDown, CheckSquare, Square,
} from "lucide-react";
import { useLocation } from "wouter";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

const STATUS_STYLES: Record<string, string> = {
  onboarding: "bg-amber-100 text-amber-800 border-amber-200",
  active: "bg-green-100 text-green-800 border-green-200",
  suspended: "bg-red-100 text-red-800 border-red-200",
  offboarding: "bg-orange-100 text-orange-800 border-orange-200",
  offboarded: "bg-slate-100 text-slate-600 border-slate-200",
};

const STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "onboarding", label: "Onboarding" },
  { value: "active", label: "Active" },
  { value: "suspended", label: "Suspended" },
  { value: "offboarding", label: "Offboarding" },
  { value: "offboarded", label: "Offboarded" },
];

type SortField = "name" | "email" | "status" | "hireDate" | "licenseCount" | "complianceScore";
type SortDir = "asc" | "desc";

function ComplianceBar({ agentId }: { agentId: string }) {
  const { data } = useGetAgentComplianceScore(agentId);
  if (!data) return <div className="w-20 h-1.5 rounded-full bg-muted" />;
  const score = data.totalScore;
  const color =
    score >= 80 ? "bg-green-500" : score >= 50 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2 min-w-[80px]">
      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${score}%` }} />
      </div>
      <span className="text-xs text-muted-foreground tabular-nums w-8 text-right">
        {Math.round(score)}
      </span>
    </div>
  );
}

function SortIcon({ field, sortBy, sortDir }: { field: SortField; sortBy: SortField; sortDir: SortDir }) {
  if (sortBy !== field) return <ChevronsUpDown className="h-3 w-3 ml-1 opacity-40" />;
  return sortDir === "asc"
    ? <ChevronUp className="h-3 w-3 ml-1 text-primary" />
    : <ChevronDown className="h-3 w-3 ml-1 text-primary" />;
}

// Multi-step Add Agent Wizard
type WizardStep = 1 | 2 | 3 | 4 | 5;

const BLANK_FORM = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  npn: "",
  hireDate: "",
  managerId: "",
  checklistTemplateId: "",
  licenseState: "",
  licenseType: "",
  licenseNumber: "",
  licenseStatus: "pending" as string,
};

function AddAgentWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { mutateAsync, isPending } = useCreateAgent();
  const [, navigate] = useLocation();
  const [step, setStep] = useState<WizardStep>(1);
  const [form, setForm] = useState(BLANK_FORM);

  const { data: usersData } = useGetUsers();
  const managerOptions = (usersData ?? []).filter(
    (u) => u.role !== "viewer" && u.role !== "agent",
  );

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((p) => ({ ...p, [k]: e.target.value }));

  const step1Valid = form.firstName.trim().length > 0 && form.lastName.trim().length > 0 && form.email.trim().length > 0;

  const handleClose = () => {
    setStep(1);
    setForm(BLANK_FORM);
    onClose();
  };

  const handleSubmit = async () => {
    try {
      const hasLicense = form.licenseState.trim().length === 2 && form.licenseType.trim().length > 0;
      const agent = await mutateAsync({
        data: {
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          email: form.email.trim(),
          phone: form.phone || undefined,
          npn: form.npn || undefined,
          hireDate: form.hireDate || undefined,
          managerId: form.managerId || undefined,
          checklistTemplateId: form.checklistTemplateId || undefined,
          initialLicense: hasLicense
            ? {
                stateCode: form.licenseState.trim().toUpperCase(),
                licenseType: form.licenseType.trim(),
                licenseNumber: form.licenseNumber || undefined,
                status: form.licenseStatus as "active" | "pending" | "expired" | "suspended" | "not_appointed",
              }
            : undefined,
        },
      });
      toast.success(`Agent ${agent.firstName} ${agent.lastName} created — onboarding checklist started`);
      void qc.invalidateQueries({ queryKey: getGetAgentsQueryKey() });
      handleClose();
      navigate(`/agents/${agent.id}`);
    } catch {
      toast.error("Failed to create agent");
    }
  };

  const { data: taskTemplates } = useGetTaskTemplates();
  const onboardingTemplates = (taskTemplates ?? []).filter(
    (t) => t.type === "onboarding" || t.type === "agent_onboarding",
  );

  const stepTitle =
    step === 1 ? "Basic Information"
    : step === 2 ? "Contact & Assignment"
    : step === 3 ? "Initial License"
    : step === 4 ? "Onboarding Checklist"
    : "Confirm Agent";
  const stepDesc =
    step === 1 ? "Enter the agent's name and email address."
    : step === 2 ? "Optional contact info, NPN, and manager assignment."
    : step === 3 ? "Optionally add the agent's first state license now."
    : step === 4 ? "Choose which onboarding checklist to start for this agent."
    : "Review the details before creating the agent.";

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add New Agent</DialogTitle>
          <div className="flex items-center gap-1 mt-2">
            {([1, 2, 3, 4, 5] as const).map((s) => (
              <div key={s} className="flex items-center gap-1">
                <div
                  className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold transition-colors
                    ${step === s ? "bg-primary text-primary-foreground" : step > s ? "bg-green-500 text-white" : "bg-muted text-muted-foreground"}`}
                >
                  {step > s ? "✓" : s}
                </div>
                {s < 5 && <div className={`w-6 h-0.5 ${step > s ? "bg-green-500" : "bg-muted"}`} />}
              </div>
            ))}
          </div>
          <p className="text-sm font-semibold mt-2">{stepTitle}</p>
          <p className="text-xs text-muted-foreground">{stepDesc}</p>
        </DialogHeader>

        <div className="py-2">
          {step === 1 && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="wiz-fn">First name *</Label>
                  <Input id="wiz-fn" value={form.firstName} onChange={set("firstName")} placeholder="Jane" autoFocus />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wiz-ln">Last name *</Label>
                  <Input id="wiz-ln" value={form.lastName} onChange={set("lastName")} placeholder="Smith" />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wiz-email">Email *</Label>
                <Input id="wiz-email" type="email" value={form.email} onChange={set("email")} placeholder="jane@agency.com" />
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="wiz-phone">Phone</Label>
                  <Input id="wiz-phone" value={form.phone} onChange={set("phone")} placeholder="(555) 000-0000" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wiz-npn">NPN</Label>
                  <Input id="wiz-npn" value={form.npn} onChange={set("npn")} placeholder="12345678" />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wiz-hire">Hire Date</Label>
                <Input id="wiz-hire" type="date" value={form.hireDate} onChange={set("hireDate")} />
              </div>
              <div className="space-y-1.5">
                <Label>Assign Manager</Label>
                <Select
                  value={form.managerId || "__none__"}
                  onValueChange={(v) => setForm((p) => ({ ...p, managerId: v === "__none__" ? "" : v }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="No manager assigned" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">No manager assigned</SelectItem>
                    {managerOptions.map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.fullName}
                        <span className="ml-2 text-xs text-muted-foreground capitalize">({u.role.replace(/_/g, " ")})</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <p className="text-xs text-muted-foreground">All fields on this step are optional.</p>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="wiz-lic-state">State Code</Label>
                  <Input
                    id="wiz-lic-state"
                    value={form.licenseState}
                    onChange={set("licenseState")}
                    placeholder="e.g. CA"
                    maxLength={2}
                    className="uppercase"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wiz-lic-type">License Type</Label>
                  <Input
                    id="wiz-lic-type"
                    value={form.licenseType}
                    onChange={set("licenseType")}
                    placeholder="e.g. Life & Health"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wiz-lic-num">License Number</Label>
                <Input
                  id="wiz-lic-num"
                  value={form.licenseNumber}
                  onChange={set("licenseNumber")}
                  placeholder="Optional"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Status</Label>
                <Select
                  value={form.licenseStatus}
                  onValueChange={(v) => setForm((p) => ({ ...p, licenseStatus: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="expired">Expired</SelectItem>
                    <SelectItem value="suspended">Suspended</SelectItem>
                    <SelectItem value="not_appointed">Not Appointed</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <p className="text-xs text-muted-foreground">
                All fields on this step are optional — you can add licenses later from the agent profile.
              </p>
            </div>
          )}

          {step === 4 && (
            <div className="space-y-3">
              <button
                type="button"
                onClick={() => setForm((p) => ({ ...p, checklistTemplateId: "" }))}
                className={`w-full text-left rounded-lg border p-3 transition-all hover:border-primary/50
                  ${form.checklistTemplateId === "" ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border"}`}
              >
                <div className="font-medium text-sm">Default Onboarding Checklist</div>
                <div className="text-xs text-muted-foreground mt-0.5">Standard NPN, licensing, AHIP, and E&O tasks</div>
              </button>
              {onboardingTemplates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setForm((p) => ({ ...p, checklistTemplateId: t.id }))}
                  className={`w-full text-left rounded-lg border p-3 transition-all hover:border-primary/50
                    ${form.checklistTemplateId === t.id ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border"}`}
                >
                  <div className="font-medium text-sm">{t.name}</div>
                  {t.description && (
                    <div className="text-xs text-muted-foreground mt-0.5 truncate">{t.description}</div>
                  )}
                </button>
              ))}
              <p className="text-xs text-muted-foreground">
                The selected checklist will be started automatically when the agent is created.
              </p>
            </div>
          )}

          {step === 5 && (
            <div className="rounded-lg border bg-muted/30 p-4 space-y-2.5">
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <span className="text-muted-foreground">Name</span>
                <span className="font-medium">{form.firstName} {form.lastName}</span>
                <span className="text-muted-foreground">Email</span>
                <span className="font-medium">{form.email}</span>
                {form.phone && <>
                  <span className="text-muted-foreground">Phone</span>
                  <span className="font-medium">{form.phone}</span>
                </>}
                {form.npn && <>
                  <span className="text-muted-foreground">NPN</span>
                  <span className="font-medium">{form.npn}</span>
                </>}
                {form.hireDate && <>
                  <span className="text-muted-foreground">Hire Date</span>
                  <span className="font-medium">{new Date(form.hireDate).toLocaleDateString()}</span>
                </>}
                {form.managerId && <>
                  <span className="text-muted-foreground">Manager</span>
                  <span className="font-medium">
                    {managerOptions.find((u) => u.id === form.managerId)?.fullName ?? "—"}
                  </span>
                </>}
                {(form.licenseState || form.licenseType) && <>
                  <span className="text-muted-foreground">Initial License</span>
                  <span className="font-medium">
                    {[form.licenseState.toUpperCase(), form.licenseType].filter(Boolean).join(" — ")}
                    {form.licenseNumber ? ` #${form.licenseNumber}` : ""}
                  </span>
                </>}
                <span className="text-muted-foreground">Checklist</span>
                <span className="font-medium">
                  {form.checklistTemplateId
                    ? (onboardingTemplates.find((t) => t.id === form.checklistTemplateId)?.name ?? "Custom")
                    : "Default Onboarding"}
                </span>
              </div>
              <div className="border-t pt-2 mt-2">
                <p className="text-xs text-muted-foreground">
                  Agent will be created and their onboarding checklist started immediately.
                </p>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          {step > 1 && (
            <Button type="button" variant="outline" onClick={() => setStep((s) => (s - 1) as WizardStep)}>
              Back
            </Button>
          )}
          <Button type="button" variant="outline" onClick={handleClose}>Cancel</Button>
          {step < 5 ? (
            <Button
              type="button"
              disabled={step === 1 && !step1Valid}
              onClick={() => setStep((s) => (s + 1) as WizardStep)}
            >
              Next
            </Button>
          ) : (
            <Button type="button" disabled={isPending} onClick={handleSubmit}>
              {isPending ? "Creating…" : "Create Agent"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Bulk Actions Bar — assign task to selected agents
function BulkActionsBar({
  selected,
  onExport,
  onClear,
}: {
  selected: Set<string>;
  onExport: () => void;
  onClear: () => void;
}) {
  const qc = useQueryClient();
  const [assignOpen, setAssignOpen] = useState(false);
  const [templateId, setTemplateId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [assigning, setAssigning] = useState(false);
  const { data: taskTemplates } = useGetTaskTemplates();

  const handleAssign = async () => {
    if (!templateId) return;
    setAssigning(true);
    try {
      const result = await customFetch<{
        created: number;
        skipped: string[];
      }>("/api/tasks/bulk-from-template", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateId,
          agentIds: Array.from(selected),
          dueDate: dueDate || undefined,
        }),
      });
      const skipMsg = result.skipped.length > 0 ? ` (${result.skipped.length} skipped)` : "";
      toast.success(
        `Created ${result.created} task${result.created !== 1 ? "s" : ""}${skipMsg}`,
      );
      void qc.invalidateQueries({ queryKey: ["/api/tasks"] });
      void qc.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
      // Per-agent task lists too — agentId is part of the cache key tail.
      void qc.invalidateQueries({ predicate: (q) =>
        Array.isArray(q.queryKey) &&
        typeof q.queryKey[0] === "string" &&
        q.queryKey[0].startsWith("/api/agents/") &&
        q.queryKey[0].endsWith("/tasks"),
      });
      setAssignOpen(false);
      setTemplateId("");
      setDueDate("");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to assign tasks",
      );
    } finally {
      setAssigning(false);
    }
  };

  return (
    <div className="flex items-center gap-3 p-3 bg-primary/5 border border-primary/20 rounded-lg">
      <span className="text-sm font-medium text-primary">{selected.size} agent{selected.size !== 1 ? "s" : ""} selected</span>
      <Button size="sm" variant="outline" onClick={onExport}>
        <Download className="h-3.5 w-3.5 mr-1.5" />
        Export Selected
      </Button>
      <Button size="sm" variant="outline" onClick={() => setAssignOpen(true)}>
        <CheckSquare className="h-3.5 w-3.5 mr-1.5" />
        Assign Task
      </Button>
      <Button size="sm" variant="ghost" className="text-muted-foreground ml-auto" onClick={onClear}>
        Clear
      </Button>

      <Dialog open={assignOpen} onOpenChange={(v) => { if (!v) { setAssignOpen(false); setTemplateId(""); setDueDate(""); } }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Assign Task to {selected.size} Agent{selected.size !== 1 ? "s" : ""}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label>Task Template</Label>
              <Select value={templateId} onValueChange={setTemplateId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a template…" />
                </SelectTrigger>
                <SelectContent>
                  {(taskTemplates ?? []).map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Due date (optional)</Label>
              <Input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">
                Overrides the template's "due in N days" offset if set.
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              This task will be created for each selected agent using the chosen template's title, description, and priority.
            </p>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setAssignOpen(false); setTemplateId(""); setDueDate(""); }}>Cancel</Button>
            <Button disabled={!templateId || assigning} onClick={handleAssign}>
              {assigning ? "Assigning…" : "Assign Task"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function AgentsPage() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [addOpen, setAddOpen] = useState(false);
  const [sortBy, setSortBy] = useState<SortField>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [, navigate] = useLocation();

  const serverSortFields: SortField[] = ["complianceScore", "status", "hireDate", "email", "name"];

  const { data, isLoading } = useGetAgents({
    search: search || undefined,
    status: status === "all" ? undefined : status,
    limit: 200,
    ...(serverSortFields.includes(sortBy) ? { sortBy, sortDir } : {}),
  });

  const agents = data?.agents ?? [];

  const sorted = useMemo(() => {
    // Server handles compliance/status/hireDate/email/name sort — skip client re-sort
    if (serverSortFields.includes(sortBy)) return agents;
    const arr = [...agents];
    arr.sort((a, b) => {
      if (sortBy === "licenseCount") {
        const av = a.activeLicenseCount ?? 0;
        const bv = b.activeLicenseCount ?? 0;
        return sortDir === "asc" ? av - bv : bv - av;
      }
      return 0;
    });
    return arr;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, sortBy, sortDir]);

  const toggleSort = (field: SortField) => {
    if (sortBy === field) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortBy(field); setSortDir("asc"); }
  };

  const allSelected = sorted.length > 0 && sorted.every((a) => selected.has(a.id));
  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(sorted.map((a) => a.id)));
  };

  const exportCSV = () => {
    const rows = sorted.filter((a) => selected.size === 0 || selected.has(a.id));
    const header = ["ID", "First Name", "Last Name", "Email", "Phone", "NPN", "Status", "Hire Date"];
    const csv = [
      header.join(","),
      ...rows.map((a) =>
        [a.id, a.firstName, a.lastName, a.email, a.phone ?? "", a.npn ?? "", a.status, a.hireDate ?? ""]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(",")
      ),
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `agents-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${rows.length} agent${rows.length !== 1 ? "s" : ""}`);
  };

  const HeaderCell = ({ field, label, className = "" }: { field: SortField; label: string; className?: string }) => (
    <button
      onClick={() => toggleSort(field)}
      className={`flex items-center text-xs font-semibold text-muted-foreground uppercase tracking-wide hover:text-foreground transition-colors ${className}`}
    >
      {label}
      <SortIcon field={field} sortBy={sortBy} sortDir={sortDir} />
    </button>
  );

  return (
    <div className="p-6 space-y-5 max-w-7xl mx-auto">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Agents</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Manage your sales agent roster</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={exportCSV}>
            <Download className="h-3.5 w-3.5 mr-1.5" />
            Export CSV
          </Button>
          <Button onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Add Agent
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search agents…"
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-44">
            <Filter className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {selected.size > 0 && (
        <BulkActionsBar
          selected={selected}
          onExport={exportCSV}
          onClear={() => setSelected(new Set())}
        />
      )}

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {[...Array(6)].map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : sorted.length === 0 ? (
            <div className="py-16 text-center">
              <Users className="h-12 w-12 mx-auto mb-3 text-muted-foreground/30" />
              <p className="text-sm font-medium text-muted-foreground">No agents found</p>
              <p className="text-xs text-muted-foreground mt-1">Add your first agent to get started</p>
              <Button className="mt-4" size="sm" onClick={() => setAddOpen(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Add Agent
              </Button>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-[auto_auto_1fr_auto_auto_auto_auto] items-center gap-4 px-5 py-2.5 border-b border-border">
                <button onClick={toggleAll} className="w-5 flex items-center text-muted-foreground hover:text-foreground">
                  {allSelected
                    ? <CheckSquare className="h-4 w-4 text-primary" />
                    : <Square className="h-4 w-4" />}
                </button>
                <span className="w-9" />
                <HeaderCell field="name" label="Agent" />
                <HeaderCell field="status" label="Status" className="hidden md:flex w-24 justify-center" />
                <HeaderCell field="hireDate" label="Hire Date" className="hidden lg:flex w-24 justify-center" />
                <HeaderCell field="licenseCount" label="Licenses" className="hidden lg:flex w-20 justify-center" />
                <HeaderCell field="complianceScore" label="Compliance" className="w-28 flex justify-end" />
              </div>
              <div className="divide-y divide-border">
                {sorted.map((agent) => (
                  <div
                    key={agent.id}
                    className={`grid grid-cols-[auto_auto_1fr_auto_auto_auto_auto] items-center gap-4 px-5 py-3.5 hover:bg-muted/40 transition-colors group
                      ${selected.has(agent.id) ? "bg-primary/5" : ""}`}
                  >
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (next.has(agent.id)) next.delete(agent.id);
                          else next.add(agent.id);
                          return next;
                        });
                      }}
                      className="w-5 flex items-center text-muted-foreground hover:text-foreground"
                    >
                      {selected.has(agent.id)
                        ? <CheckSquare className="h-4 w-4 text-primary" />
                        : <Square className="h-4 w-4" />}
                    </button>
                    <Avatar
                      className="h-9 w-9 shrink-0 cursor-pointer"
                      onClick={() => navigate(`/agents/${agent.id}`)}
                    >
                      <AvatarImage src={agent.avatarUrl ?? undefined} />
                      <AvatarFallback className="text-xs bg-primary/10 text-primary">
                        {agent.firstName[0]}{agent.lastName[0]}
                      </AvatarFallback>
                    </Avatar>
                    <div
                      className="min-w-0 cursor-pointer"
                      onClick={() => navigate(`/agents/${agent.id}`)}
                    >
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-sm text-foreground">{agent.firstName} {agent.lastName}</p>
                        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors" />
                      </div>
                      <p className="text-xs text-muted-foreground truncate">{agent.email}</p>
                    </div>
                    <div className="w-24 hidden md:flex justify-center">
                      <Badge
                        variant="secondary"
                        className={`text-xs shrink-0 capitalize border ${STATUS_STYLES[agent.status] ?? ""}`}
                      >
                        {agent.status}
                      </Badge>
                    </div>
                    <span className="text-xs text-muted-foreground hidden lg:block w-24 text-center tabular-nums">
                      {agent.hireDate ? new Date(agent.hireDate).toLocaleDateString() : "—"}
                    </span>
                    <div className="hidden lg:flex w-20 justify-center">
                      {agent.activeLicenseCount != null ? (
                        <span className={`text-xs font-semibold tabular-nums px-2 py-0.5 rounded-full ${
                          agent.activeLicenseCount === 0
                            ? "bg-red-100 text-red-700"
                            : agent.activeLicenseCount < 3
                            ? "bg-amber-100 text-amber-700"
                            : "bg-green-100 text-green-700"
                        }`}>
                          {agent.activeLicenseCount}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </div>
                    <div className="w-28 flex justify-end">
                      <ComplianceBar agentId={agent.id} />
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {data && (
        <p className="text-xs text-muted-foreground text-center">
          Showing {sorted.length} of {data.total} agents
          {selected.size > 0 && ` · ${selected.size} selected`}
        </p>
      )}

      <AddAgentWizard open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}
