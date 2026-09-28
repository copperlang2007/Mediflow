/**
 * Rule builder + run history dialogs for Workflow Automation. Moved here from
 * the old Automations page so the one Workflow page owns the whole feature.
 * They talk to the real `/api/automations/rules` endpoints.
 */
import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { AlertCircle, CheckCircle2, Clock, Plus, Trash2, XCircle } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetAutomationRuleLogsQueryKey,
  getGetAutomationRulesQueryKey,
  useCreateAutomationRule,
  useGetAutomationRuleLogs,
  useUpdateAutomationRule,
  type AutomationAction,
  type AutomationCondition,
  type AutomationRule,
  type CreateAutomationRuleBody,
  type GetAutomationRuleLogsResult,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { AgentPicker, PipelineStagePicker, SequencePicker, StatusPill, UserPicker } from "@/components/shared";
import { ACTIONS, TRIGGERS, TRIGGER_BY_VALUE, ruleSentence } from "./workflowCopy";

const CONDITION_FIELDS = [
  { value: "status", label: "Status" },
  { value: "contactStatus", label: "Client status" },
  { value: "source", label: "Lead source" },
  { value: "assignedAgentId", label: "Assigned agent ID" },
  { value: "stateCode", label: "State" },
  { value: "carrierId", label: "Carrier ID" },
  { value: "daysUntilExpiry", label: "Days until expiry" },
  { value: "daysSinceActivity", label: "Days since last contact" },
  { value: "daysOverdue", label: "Days overdue" },
  { value: "currentStatus", label: "Current status" },
  { value: "newStatus", label: "New status" },
  { value: "oldStatus", label: "Old status" },
];

const CONDITION_OPERATORS = [
  { value: "eq", label: "is" },
  { value: "neq", label: "is not" },
  { value: "contains", label: "contains" },
  { value: "gt", label: "is more than" },
  { value: "lt", label: "is less than" },
  { value: "exists", label: "is filled in" },
];

function ActionConfigEditor({ action, onChange }: { action: AutomationAction; onChange: (a: AutomationAction) => void }) {
  const update = (key: string, value: string) => onChange({ ...action, config: { ...action.config, [key]: value } });
  const field = (key: string, placeholder: string, type = "text") => (
    <Input
      type={type}
      placeholder={placeholder}
      value={(action.config[key] as string) ?? ""}
      onChange={(e) => update(key, e.target.value)}
      className="h-8 text-xs"
    />
  );

  switch (action.type) {
    case "create_task":
      return (
        <div className="mt-2 space-y-2">
          {field("title", "Task title")}
          <AgentPicker
            aria-label="Assign to agent"
            value={(action.config.agentId as string) ?? ""}
            onChange={(v) => update("agentId", v)}
            noneLabel="The client's or record's own agent"
            placeholder="Assign to agent (optional)"
          />
          {field("dueDate", "Due date (optional)", "date")}
        </div>
      );
    case "send_email":
      return <div className="mt-2 space-y-2">{field("to", "To email")}{field("subject", "Subject")}{field("html", "Message")}</div>;
    case "send_sms":
      return <div className="mt-2 space-y-2">{field("to", "To phone")}{field("body", "Message")}</div>;
    case "change_contact_status":
      return (
        <div className="mt-2">
          <Select value={(action.config.status as string) ?? ""} onValueChange={(v) => update("status", v)}>
            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="New status" /></SelectTrigger>
            <SelectContent>
              {["lead", "prospect", "enrolled", "retained", "lost", "do_not_contact"].map((s) => (
                <SelectItem key={s} value={s} className="text-xs">{s.replace(/_/g, " ")}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      );
    case "enroll_sequence":
      return (
        <SequencePicker
          className="mt-2"
          aria-label="Sequence"
          value={(action.config.sequenceId as string) ?? ""}
          onChange={(v) => update("sequenceId", v)}
        />
      );
    case "change_deal_stage":
      return (
        <PipelineStagePicker
          className="mt-2"
          aria-label="Pipeline stage"
          value={(action.config.stageId as string) ?? ""}
          onChange={(v) => update("stageId", v)}
        />
      );
    case "create_appointment":
      return (
        <div className="mt-2 space-y-2">
          {field("title", "Appointment title")}
          <div className="grid grid-cols-3 gap-2">
            {field("startOffsetDays", "Days from now (1)")}
            {field("startTime", "Start (client's time)", "time")}
            {field("durationMinutes", "Minutes (30)")}
          </div>
          <Select value={(action.config.type as string) ?? "consultation"} onValueChange={(v) => update("type", v)}>
            <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="Type" /></SelectTrigger>
            <SelectContent>
              {["enrollment", "review", "renewal", "consultation", "other"].map((s) => (
                <SelectItem key={s} value={s} className="text-xs">{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">Books a pending appointment for the trigger's client and agent, at that time in the client's timezone.</p>
        </div>
      );
    case "send_notification":
      return (
        <div className="mt-2 space-y-2">
          {field("message", "Alert message")}
          <UserPicker
            aria-label="Who gets the alert"
            value={(action.config.userId as string) ?? ""}
            onChange={(v) => update("userId", v)}
            noneLabel="All admins"
          />
        </div>
      );
    default:
      return null;
  }
}

export function RuleBuilderDialog({
  open,
  onClose,
  editRule,
}: {
  open: boolean;
  onClose: () => void;
  editRule?: AutomationRule;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { mutateAsync: createRule, isPending: creating } = useCreateAutomationRule();
  const { mutateAsync: updateRule, isPending: updating } = useUpdateAutomationRule();

  const [name, setName] = useState(editRule?.name ?? "");
  const [triggerType, setTriggerType] = useState(editRule?.triggerType ?? "lead_created");
  const [days, setDays] = useState<string>(String((editRule?.triggerConfig as Record<string, unknown> | null)?.daysThreshold ?? "30"));
  const [conditions, setConditions] = useState<AutomationCondition[]>((editRule?.conditions as AutomationCondition[] | null) ?? []);
  const [actions, setActions] = useState<AutomationAction[]>(
    (editRule?.actions as AutomationAction[] | null) ?? [{ type: "create_task", config: { title: "" } }],
  );

  const usesDays = TRIGGER_BY_VALUE.get(triggerType)?.usesDays ?? false;
  const triggerConfig = usesDays ? { daysThreshold: Number(days) || 30 } : undefined;
  const isPending = creating || updating;

  const updateCondition = (i: number, updates: Partial<AutomationCondition>) =>
    setConditions((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...updates } : c)));
  const updateAction = (i: number, a: AutomationAction) => setActions((as) => as.map((x, idx) => (idx === i ? a : x)));

  const handleSave = async () => {
    if (!name.trim() || actions.length === 0) {
      toast({ title: "Almost there", description: "Give the rule a name and at least one step.", variant: "destructive" });
      return;
    }
    try {
      const body: CreateAutomationRuleBody = {
        name: name.trim(),
        triggerType,
        triggerConfig,
        conditions,
        actions,
        isActive: editRule?.isActive ?? true,
      };
      if (editRule) {
        await updateRule({ id: editRule.id, data: body });
        toast({ title: "Rule updated" });
      } else {
        await createRule({ data: body });
        toast({ title: "Rule created", description: "It will run the next time its trigger happens." });
      }
      void qc.invalidateQueries({ queryKey: getGetAutomationRulesQueryKey() });
      onClose();
    } catch {
      toast({ title: "Couldn't save the rule", description: "Please check the steps and try again.", variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display">{editRule ? "Edit rule" : "New rule"}</DialogTitle>
          <DialogDescription>{ruleSentence(triggerType, triggerConfig, actions)}</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div>
            <Label className="text-xs font-medium">Rule name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Welcome call for new leads" className="mt-1" />
          </div>

          <div className="space-y-2">
            <Label className="text-xs font-medium">When this happens…</Label>
            <Select value={triggerType} onValueChange={(v) => { setTriggerType(v); setDays("30"); }}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                {TRIGGERS.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
              </SelectContent>
            </Select>
            {usesDays && (
              <div className="flex items-center gap-2 mt-1">
                <Label className="text-xs text-muted-foreground whitespace-nowrap">Within</Label>
                <Input type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} className="h-8 text-xs w-20" />
                <Label className="text-xs text-muted-foreground">days</Label>
              </div>
            )}
          </div>

          <Separator />

          <div>
            <div className="flex items-center justify-between mb-2">
              <Label className="text-xs font-medium">Only if… (optional)</Label>
              <Button size="sm" variant="outline" className="h-7 text-xs"
                onClick={() => setConditions((c) => [...c, { field: "status", operator: "eq", value: "", logic: "and" }])}>
                <Plus className="h-3 w-3 mr-1" />Add condition
              </Button>
            </div>
            {conditions.length === 0 && (
              <p className="text-xs text-muted-foreground py-2 px-3 bg-muted rounded-md">No conditions — the rule runs every time.</p>
            )}
            {conditions.map((cond, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 mb-2">
                {i > 0 ? (
                  <Select value={cond.logic ?? "and"} onValueChange={(v) => updateCondition(i, { logic: v as AutomationCondition["logic"] })}>
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
                  <SelectTrigger className="h-8 text-xs w-36"><SelectValue /></SelectTrigger>
                  <SelectContent>{CONDITION_FIELDS.map((f) => <SelectItem key={f.value} value={f.value} className="text-xs">{f.label}</SelectItem>)}</SelectContent>
                </Select>
                <Select value={cond.operator} onValueChange={(v) => updateCondition(i, { operator: v as AutomationCondition["operator"] })}>
                  <SelectTrigger className="h-8 text-xs w-32"><SelectValue /></SelectTrigger>
                  <SelectContent>{CONDITION_OPERATORS.map((o) => <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>)}</SelectContent>
                </Select>
                <Input className="h-8 text-xs flex-1 min-w-[100px]" value={String(cond.value ?? "")} onChange={(e) => updateCondition(i, { value: e.target.value })} placeholder="Value" />
                <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" aria-label="Remove condition"
                  onClick={() => setConditions((cs) => cs.filter((_, idx) => idx !== i))}>
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </div>
            ))}
          </div>

          <Separator />

          <div>
            <div className="flex items-center justify-between mb-2">
              <Label className="text-xs font-medium">…then do this (in order)</Label>
              <Button size="sm" variant="outline" className="h-7 text-xs"
                onClick={() => setActions((a) => [...a, { type: "create_task", config: { title: "" } }])}>
                <Plus className="h-3 w-3 mr-1" />Add step
              </Button>
            </div>
            {actions.map((action, i) => (
              <div key={i} className="border border-border rounded-lg p-3 mb-2 bg-muted/20">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground w-4">{i + 1}.</span>
                  <Select value={action.type} onValueChange={(v) => updateAction(i, { type: v as AutomationAction["type"], config: {} })}>
                    <SelectTrigger className="h-8 text-xs flex-1"><SelectValue /></SelectTrigger>
                    <SelectContent>{ACTIONS.map((a) => <SelectItem key={a.value} value={a.value} className="text-xs">{a.label}</SelectItem>)}</SelectContent>
                  </Select>
                  <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" aria-label="Remove step"
                    onClick={() => setActions((as) => as.filter((_, idx) => idx !== i))}>
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
            {isPending ? "Saving…" : editRule ? "Save changes" : "Create rule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const RESULT_ICON = {
  success: <CheckCircle2 className="h-4 w-4 text-success" />,
  partial: <AlertCircle className="h-4 w-4 text-warning" />,
  failed: <XCircle className="h-4 w-4 text-destructive" />,
};

export function RuleLogsDialog({ rule, open, onClose }: { rule: AutomationRule; open: boolean; onClose: () => void }) {
  const [resultFilter, setResultFilter] = useState("all");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const params = {
    ...(resultFilter !== "all" ? { result: resultFilter as GetAutomationRuleLogsResult } : {}),
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
  };
  const { data: logs, isLoading } = useGetAutomationRuleLogs(rule.id, params, {
    query: { enabled: open, queryKey: getGetAutomationRuleLogsQueryKey(rule.id, params) },
  });
  const list = Array.isArray(logs) ? logs : [];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display flex items-center gap-2">
            <Clock className="h-4 w-4" /> Run history — {rule.name}
          </DialogTitle>
          <DialogDescription>Every time this rule ran, newest first.</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 flex-wrap pb-2">
          <Select value={resultFilter} onValueChange={setResultFilter}>
            <SelectTrigger className="h-8 text-xs w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">All results</SelectItem>
              <SelectItem value="success" className="text-xs">Worked</SelectItem>
              <SelectItem value="partial" className="text-xs">Partly worked</SelectItem>
              <SelectItem value="failed" className="text-xs">Failed</SelectItem>
            </SelectContent>
          </Select>
          <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="h-8 text-xs w-36" aria-label="From" />
          <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="h-8 text-xs w-36" aria-label="To" />
        </div>
        {isLoading ? (
          <div className="space-y-2">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
        ) : list.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">This rule hasn't run yet.</p>
        ) : (
          <div className="divide-y divide-border">
            {list.map((log) => (
              <div key={log.id} className="py-3 flex items-start gap-3">
                <div className="pt-0.5">{RESULT_ICON[log.result]}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <StatusPill tone={log.result === "success" ? "success" : log.result === "partial" ? "warning" : "danger"}>
                      {log.result === "success" ? "Worked" : log.result === "partial" ? "Partly worked" : "Failed"}
                    </StatusPill>
                    {log.matchedRecordType && <span className="text-xs text-muted-foreground">{log.matchedRecordType}</span>}
                  </div>
                  {Array.isArray(log.actionsExecuted) && log.actionsExecuted.length > 0 && (
                    <p className="text-xs text-muted-foreground mt-0.5">Steps: {(log.actionsExecuted as string[]).join(", ")}</p>
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
