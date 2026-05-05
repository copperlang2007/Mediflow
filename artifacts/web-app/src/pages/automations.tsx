/**
 * Settings → Automations page.
 * Rule builder UI with trigger picker, condition builder (AND logic),
 * action list (multi-action), enable/disable toggle, run history, manual run.
 */

import { useState } from "react";
import { Plus, Zap, Play, ToggleLeft, ToggleRight, Trash2, ChevronRight, Clock, CheckCircle2, XCircle, AlertCircle, RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetAutomationRules,
  useCreateAutomationRule,
  useUpdateAutomationRule,
  useDeleteAutomationRule,
  useToggleAutomationRule,
  useRunAutomationRule,
  useGetAutomationRuleLogs,
  getGetAutomationRulesQueryKey,
  getGetAutomationRuleLogsQueryKey,
  GetAutomationRuleLogsResult,
  type AutomationRule,
  type AutomationCondition,
  type AutomationAction,
  type CreateAutomationRuleBody,
} from "@workspace/api-client-react";

// ---- Constants ----

const TRIGGER_OPTIONS = [
  { value: "license_expires", label: "License expires in N days" },
  { value: "certification_expiring", label: "Certification expiring" },
  { value: "ahip_deadline", label: "AHIP deadline approaching" },
  { value: "lead_created", label: "New lead created" },
  { value: "lead_status_changed", label: "Lead status changes" },
  { value: "contact_no_activity", label: "Contact has no activity for N days" },
  { value: "deal_stage_changed", label: "Deal moves to stage" },
  { value: "task_overdue", label: "Task is overdue" },
  { value: "enrollment_period_opens", label: "Enrollment period opens" },
  { value: "scheduled", label: "Scheduled (weekly sweep)" },
];

const CONDITION_FIELDS = [
  { value: "status", label: "Status" },
  { value: "contactStatus", label: "Contact status" },
  { value: "source", label: "Lead source" },
  { value: "assignedAgentId", label: "Assigned agent ID" },
  { value: "stateCode", label: "State code" },
  { value: "carrierId", label: "Carrier ID" },
  { value: "daysUntilExpiry", label: "Days until expiry" },
  { value: "daysSinceActivity", label: "Days since activity" },
  { value: "daysOverdue", label: "Days overdue" },
  { value: "currentStatus", label: "Current status" },
  { value: "newStatus", label: "New status" },
  { value: "oldStatus", label: "Old status" },
];

const CONDITION_OPERATORS = [
  { value: "eq", label: "equals" },
  { value: "neq", label: "not equals" },
  { value: "contains", label: "contains" },
  { value: "gt", label: "greater than" },
  { value: "lt", label: "less than" },
  { value: "exists", label: "exists" },
];

const ACTION_OPTIONS = [
  { value: "create_task", label: "Create task" },
  { value: "send_notification", label: "Send in-app notification" },
  { value: "send_email", label: "Send email" },
  { value: "send_sms", label: "Send SMS" },
  { value: "change_contact_status", label: "Change contact status" },
  { value: "enroll_sequence", label: "Enroll in sequence" },
  { value: "change_deal_stage", label: "Change deal stage" },
];

const RESULT_ICONS = {
  success: <CheckCircle2 className="h-4 w-4 text-green-500" />,
  partial: <AlertCircle className="h-4 w-4 text-yellow-500" />,
  failed: <XCircle className="h-4 w-4 text-red-500" />,
};

// ---- Action Config Editor ----

function ActionConfigEditor({ action, onChange }: { action: AutomationAction; onChange: (a: AutomationAction) => void }) {
  const update = (key: string, value: string) => onChange({ ...action, config: { ...action.config, [key]: value } });

  switch (action.type) {
    case "create_task":
      return (
        <div className="space-y-2 mt-2">
          <Input placeholder="Task title" value={(action.config.title as string) ?? ""} onChange={(e) => update("title", e.target.value)} className="text-xs h-7" />
          <Input placeholder="Assign to agent ID (optional)" value={(action.config.agentId as string) ?? ""} onChange={(e) => update("agentId", e.target.value)} className="text-xs h-7" />
          <Input type="date" placeholder="Due date (optional)" value={(action.config.dueDate as string) ?? ""} onChange={(e) => update("dueDate", e.target.value)} className="text-xs h-7" />
        </div>
      );
    case "send_email":
      return (
        <div className="space-y-2 mt-2">
          <Input placeholder="To email" value={(action.config.to as string) ?? ""} onChange={(e) => update("to", e.target.value)} className="text-xs h-7" />
          <Input placeholder="Subject" value={(action.config.subject as string) ?? ""} onChange={(e) => update("subject", e.target.value)} className="text-xs h-7" />
          <Input placeholder="Body HTML" value={(action.config.html as string) ?? ""} onChange={(e) => update("html", e.target.value)} className="text-xs h-7" />
        </div>
      );
    case "send_sms":
      return (
        <div className="space-y-2 mt-2">
          <Input placeholder="To phone" value={(action.config.to as string) ?? ""} onChange={(e) => update("to", e.target.value)} className="text-xs h-7" />
          <Input placeholder="Message body" value={(action.config.body as string) ?? ""} onChange={(e) => update("body", e.target.value)} className="text-xs h-7" />
        </div>
      );
    case "change_contact_status":
      return (
        <div className="mt-2">
          <Select value={(action.config.status as string) ?? ""} onValueChange={(v) => update("status", v)}>
            <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="New status" /></SelectTrigger>
            <SelectContent>
              {["prospect", "enrolled", "retained", "lapsed", "inactive"].map((s) => (
                <SelectItem key={s} value={s} className="text-xs">{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      );
    case "enroll_sequence":
      return (
        <div className="mt-2">
          <Input placeholder="Sequence ID" value={(action.config.sequenceId as string) ?? ""} onChange={(e) => update("sequenceId", e.target.value)} className="text-xs h-7" />
        </div>
      );
    case "change_deal_stage":
      return (
        <div className="mt-2">
          <Input placeholder="Pipeline Stage ID" value={(action.config.stageId as string) ?? ""} onChange={(e) => update("stageId", e.target.value)} className="text-xs h-7" />
        </div>
      );
    case "send_notification":
      return (
        <div className="space-y-2 mt-2">
          <Input placeholder="Notification message" value={(action.config.message as string) ?? ""} onChange={(e) => update("message", e.target.value)} className="text-xs h-7" />
          <Input placeholder="User ID (leave blank to notify all admins)" value={(action.config.userId as string) ?? ""} onChange={(e) => update("userId", e.target.value)} className="text-xs h-7" />
        </div>
      );
    default:
      return null;
  }
}

// ---- Rule Builder Dialog ----

function RuleBuilderDialog({
  open,
  onClose,
  editRule,
}: {
  open: boolean;
  onClose: () => void;
  editRule?: AutomationRule;
}) {
  const qc = useQueryClient();
  const { mutateAsync: createRule, isPending: creating } = useCreateAutomationRule();
  const { mutateAsync: updateRule, isPending: updating } = useUpdateAutomationRule();

  const [name, setName] = useState(editRule?.name ?? "");
  const [triggerType, setTriggerType] = useState(editRule?.triggerType ?? "lead_created");
  const [triggerDaysThreshold, setTriggerDaysThreshold] = useState<string>(
    String((editRule?.triggerConfig as Record<string, unknown> | null)?.daysThreshold ?? "30"),
  );
  const [conditions, setConditions] = useState<AutomationCondition[]>(
    (editRule?.conditions as AutomationCondition[] | null) ?? [],
  );
  const [actions, setActions] = useState<AutomationAction[]>(
    (editRule?.actions as AutomationAction[] | null) ?? [{ type: "create_task", config: { title: "" } }],
  );

  const TIME_THRESHOLD_TRIGGERS = ["license_expires", "certification_expiring", "contact_no_activity", "task_overdue", "ahip_deadline"];
  const showDaysThreshold = TIME_THRESHOLD_TRIGGERS.includes(triggerType);

  const isPending = creating || updating;

  const addCondition = () =>
    setConditions((c) => [...c, { field: "status", operator: "eq", value: "", logic: "and" }]);

  const updateCondition = (i: number, updates: Partial<AutomationCondition>) =>
    setConditions((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...updates } : c)));

  const removeCondition = (i: number) =>
    setConditions((cs) => cs.filter((_, idx) => idx !== i));

  const addAction = () =>
    setActions((a) => [...a, { type: "create_task", config: { title: "" } }]);

  const updateAction = (i: number, a: AutomationAction) =>
    setActions((as) => as.map((x, idx) => (idx === i ? a : x)));

  const removeAction = (i: number) =>
    setActions((as) => as.filter((_, idx) => idx !== i));

  const handleSave = async () => {
    if (!name.trim() || actions.length === 0) {
      toast.error("Name and at least one action are required");
      return;
    }
    try {
      const body: CreateAutomationRuleBody = {
        name,
        triggerType: triggerType as CreateAutomationRuleBody["triggerType"],
        triggerConfig: showDaysThreshold ? { daysThreshold: Number(triggerDaysThreshold) || 30 } : undefined,
        conditions,
        actions,
        isActive: true,
      };
      if (editRule) {
        await updateRule({ id: editRule.id, data: body });
        toast.success("Automation rule updated");
      } else {
        await createRule({ data: body });
        toast.success("Automation rule created");
      }
      void qc.invalidateQueries({ queryKey: getGetAutomationRulesQueryKey() });
      onClose();
    } catch {
      toast.error("Failed to save rule");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editRule ? "Edit Automation Rule" : "New Automation Rule"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          {/* Name */}
          <div>
            <Label className="text-xs font-medium">Rule name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Alert when license expires in 30 days" className="mt-1" />
          </div>

          {/* Trigger */}
          <div className="space-y-2">
            <Label className="text-xs font-medium">Trigger</Label>
            <Select value={triggerType} onValueChange={(v) => { setTriggerType(v); setTriggerDaysThreshold("30"); }}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                {TRIGGER_OPTIONS.map((t) => (
                  <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {showDaysThreshold && (
              <div className="flex items-center gap-2 mt-1">
                <Label className="text-xs text-muted-foreground whitespace-nowrap">Fire when within</Label>
                <Input
                  type="number"
                  min={1}
                  max={365}
                  value={triggerDaysThreshold}
                  onChange={(e) => setTriggerDaysThreshold(e.target.value)}
                  className="h-7 text-xs w-20"
                />
                <Label className="text-xs text-muted-foreground">days</Label>
              </div>
            )}
          </div>

          <Separator />

          {/* Conditions */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label className="text-xs font-medium">Conditions</Label>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={addCondition}>
                <Plus className="h-3 w-3 mr-1" />Add condition
              </Button>
            </div>
            {conditions.length === 0 && (
              <p className="text-xs text-muted-foreground py-2 px-3 bg-muted rounded-md">No conditions — rule matches all records</p>
            )}
            {conditions.map((cond, i) => (
              <div key={i} className="flex items-center gap-2 mb-2">
                {i > 0 ? (
                  <Select
                    value={(cond as AutomationCondition & { logic?: string }).logic ?? "and"}
                    onValueChange={(v) => updateCondition(i, { ...(cond as object), logic: v } as Partial<AutomationCondition>)}
                  >
                    <SelectTrigger className="h-8 text-xs w-16 shrink-0 font-semibold"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="and" className="text-xs font-semibold">AND</SelectItem>
                      <SelectItem value="or" className="text-xs font-semibold">OR</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <span className="text-xs text-muted-foreground w-16 shrink-0 text-center">IF</span>
                )}
                <Select value={cond.field} onValueChange={(v) => updateCondition(i, { field: v })}>
                  <SelectTrigger className="h-8 text-xs w-32"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CONDITION_FIELDS.map((f) => <SelectItem key={f.value} value={f.value} className="text-xs">{f.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={cond.operator} onValueChange={(v) => updateCondition(i, { operator: v as AutomationCondition["operator"] })}>
                  <SelectTrigger className="h-8 text-xs w-28"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CONDITION_OPERATORS.map((o) => <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Input
                  className="h-8 text-xs flex-1"
                  value={String(cond.value ?? "")}
                  onChange={(e) => updateCondition(i, { value: e.target.value })}
                  placeholder="Value"
                />
                <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" onClick={() => removeCondition(i)}>
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </div>
            ))}
          </div>

          <Separator />

          {/* Actions */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label className="text-xs font-medium">Actions (executed in order)</Label>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={addAction}>
                <Plus className="h-3 w-3 mr-1" />Add action
              </Button>
            </div>
            {actions.map((action, i) => (
              <div key={i} className="border border-border rounded-lg p-3 mb-2 bg-muted/20">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground w-4">{i + 1}.</span>
                  <Select
                    value={action.type}
                    onValueChange={(v) => updateAction(i, { type: v as AutomationAction["type"], config: {} })}
                  >
                    <SelectTrigger className="h-8 text-xs flex-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {ACTION_OPTIONS.map((a) => <SelectItem key={a.value} value={a.value} className="text-xs">{a.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" onClick={() => removeAction(i)}>
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                </div>
                <ActionConfigEditor action={action} onChange={(a) => updateAction(i, a)} />
              </div>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void handleSave()} disabled={isPending}>
            {isPending ? "Saving…" : editRule ? "Update Rule" : "Create Rule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Rule Logs Modal ----

function RuleLogsModal({ rule, open, onClose }: { rule: AutomationRule; open: boolean; onClose: () => void }) {
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [resultFilter, setResultFilter] = useState("");

  const params = {
    ...(resultFilter ? { result: resultFilter as GetAutomationRuleLogsResult } : {}),
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
  };

  const { data: logs, isLoading } = useGetAutomationRuleLogs(rule.id, params, {
    query: { enabled: open, queryKey: getGetAutomationRuleLogsQueryKey(rule.id, params) },
  });

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock className="h-4 w-4" />
            Execution History — {rule.name}
          </DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2 flex-wrap pb-2">
          <Select value={resultFilter} onValueChange={setResultFilter}>
            <SelectTrigger className="h-7 text-xs w-32"><SelectValue placeholder="All results" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="" className="text-xs">All results</SelectItem>
              <SelectItem value="success" className="text-xs">Success</SelectItem>
              <SelectItem value="partial" className="text-xs">Partial</SelectItem>
              <SelectItem value="failed" className="text-xs">Failed</SelectItem>
            </SelectContent>
          </Select>
          <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="h-7 text-xs w-36" placeholder="From" />
          <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="h-7 text-xs w-36" placeholder="To" />
          {(startDate || endDate || resultFilter) && (
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setStartDate(""); setEndDate(""); setResultFilter(""); }}>
              Clear
            </Button>
          )}
        </div>
        {isLoading ? (
          <div className="space-y-2">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
        ) : !logs?.length ? (
          <div className="py-10 text-center text-sm text-muted-foreground">No executions yet</div>
        ) : (
          <div className="divide-y divide-border">
            {(Array.isArray(logs) ? logs : []).map((log) => (
              <div key={log.id} className="py-3 flex items-start gap-3">
                <div className="pt-0.5">{RESULT_ICONS[log.result]}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant={log.result === "success" ? "default" : log.result === "partial" ? "secondary" : "destructive"} className="text-[10px]">
                      {log.result}
                    </Badge>
                    {log.matchedRecordType && (
                      <span className="text-xs text-muted-foreground">{log.matchedRecordType}: {log.matchedRecordId ?? "—"}</span>
                    )}
                  </div>
                  {log.actionsExecuted && (
                    <p className="text-xs text-muted-foreground mt-0.5">Actions: {(log.actionsExecuted as string[]).join(", ")}</p>
                  )}
                  {log.errorMessage && <p className="text-xs text-destructive mt-0.5">{log.errorMessage}</p>}
                </div>
                <span className="text-xs text-muted-foreground shrink-0">
                  {formatDistanceToNow(new Date(log.executedAt), { addSuffix: true })}
                </span>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---- Rule Card ----

function RuleCard({ rule }: { rule: AutomationRule }) {
  const qc = useQueryClient();
  const { mutateAsync: toggle } = useToggleAutomationRule();
  const { mutateAsync: deleteRule } = useDeleteAutomationRule();
  const { mutateAsync: runRule, isPending: running } = useRunAutomationRule();
  const [editOpen, setEditOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);

  const handleToggle = async () => {
    try {
      await toggle({ id: rule.id });
      void qc.invalidateQueries({ queryKey: getGetAutomationRulesQueryKey() });
      toast.success(rule.isActive ? "Rule disabled" : "Rule enabled");
    } catch { toast.error("Failed to toggle rule"); }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete rule "${rule.name}"?`)) return;
    try {
      await deleteRule({ id: rule.id });
      void qc.invalidateQueries({ queryKey: getGetAutomationRulesQueryKey() });
      toast.success("Rule deleted");
    } catch { toast.error("Failed to delete rule"); }
  };

  const handleRun = async () => {
    try {
      await runRule({ id: rule.id, data: {} });
      void qc.invalidateQueries({ queryKey: getGetAutomationRuleLogsQueryKey(rule.id) });
      toast.success("Rule queued for execution");
    } catch { toast.error("Failed to run rule"); }
  };

  const triggerLabel = TRIGGER_OPTIONS.find((t) => t.value === rule.triggerType)?.label ?? rule.triggerType;
  const actionCount = (rule.actions as AutomationAction[] | null)?.length ?? 0;

  return (
    <>
      <Card className={!rule.isActive ? "opacity-60" : ""}>
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-sm truncate">{rule.name}</span>
                <Badge variant={rule.isActive ? "default" : "secondary"} className="text-[10px]">
                  {rule.isActive ? "Active" : "Disabled"}
                </Badge>
              </div>
              <div className="flex items-center gap-3 mt-1 flex-wrap">
                <span className="text-xs text-muted-foreground flex items-center gap-1">
                  <Zap className="h-3 w-3" />
                  {triggerLabel}
                </span>
                <span className="text-xs text-muted-foreground">{actionCount} action{actionCount !== 1 ? "s" : ""}</span>
                {rule.runCount > 0 && (
                  <span className="text-xs text-muted-foreground">
                    Ran {rule.runCount}× {rule.lastRunAt && `· ${formatDistanceToNow(new Date(rule.lastRunAt), { addSuffix: true })}`}
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Button size="icon" variant="ghost" className="h-8 w-8" title="Run now" onClick={() => void handleRun()} disabled={running}>
                {running ? <RefreshCcw className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              </Button>
              <Button size="icon" variant="ghost" className="h-8 w-8" title="Execution history" onClick={() => setLogsOpen(true)}>
                <Clock className="h-3.5 w-3.5" />
              </Button>
              <Button size="icon" variant="ghost" className="h-8 w-8" title="Edit" onClick={() => setEditOpen(true)}>
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
              <Button size="icon" variant="ghost" className="h-8 w-8" title={rule.isActive ? "Disable" : "Enable"} onClick={() => void handleToggle()}>
                {rule.isActive ? <ToggleRight className="h-4 w-4 text-primary" /> : <ToggleLeft className="h-4 w-4" />}
              </Button>
              <Button size="icon" variant="ghost" className="h-8 w-8" title="Delete" onClick={() => void handleDelete()}>
                <Trash2 className="h-3.5 w-3.5 text-destructive" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {editOpen && <RuleBuilderDialog open={editOpen} onClose={() => setEditOpen(false)} editRule={rule} />}
      {logsOpen && <RuleLogsModal rule={rule} open={logsOpen} onClose={() => setLogsOpen(false)} />}
    </>
  );
}

// ---- Main Page ----

export default function AutomationsPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const [triggerFilter, setTriggerFilter] = useState("all");
  const { data, isLoading } = useGetAutomationRules(
    triggerFilter !== "all" ? { triggerType: triggerFilter } : {},
  );

  const rules = data?.rules ?? [];
  const total = data?.total ?? 0;
  const activeCount = rules.filter((r) => r.isActive).length;

  return (
    <div className="p-6 space-y-5 max-w-5xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">Automation Rules</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {total} rule{total !== 1 ? "s" : ""} · {activeCount} active
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4 mr-1" />New Rule
        </Button>
      </div>

      {/* Filter */}
      <div className="flex items-center gap-3">
        <Select value={triggerFilter} onValueChange={setTriggerFilter}>
          <SelectTrigger className="w-56 h-8 text-xs">
            <SelectValue placeholder="Filter by trigger" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All triggers</SelectItem>
            {TRIGGER_OPTIONS.map((t) => (
              <SelectItem key={t.value} value={t.value} className="text-xs">{t.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Rules list */}
      {isLoading ? (
        <div className="space-y-3">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
      ) : rules.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <Zap className="h-12 w-12 mx-auto mb-3 text-muted-foreground/20" />
            <p className="text-sm font-medium text-muted-foreground">No automation rules yet</p>
            <p className="text-xs text-muted-foreground mt-1">Create rules to automate tasks, notifications, and outreach based on platform events.</p>
            <Button className="mt-4" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4 mr-1" />Create First Rule
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {rules.map((rule) => <RuleCard key={rule.id} rule={rule} />)}
        </div>
      )}

      {createOpen && <RuleBuilderDialog open={createOpen} onClose={() => setCreateOpen(false)} />}
    </div>
  );
}
