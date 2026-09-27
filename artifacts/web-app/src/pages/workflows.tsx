/**
 * Workflow Automation (agencyBRIDGE WorkflowPage) on Mediflow's real rules
 * engine: `/api/automations/rules` (list, create, edit, toggle, run, delete),
 * `/rules/:id/logs` and `/automations/recent-activity`.
 *
 * This is the ONE automation page — `/automations` redirects here.
 */
import { useState, type ComponentType } from "react";
import { formatDistanceToNow } from "date-fns";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  CheckCircle2,
  CheckSquare,
  Clock,
  GitBranch,
  ListOrdered,
  Mail,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  RefreshCcw,
  Trash2,
  UserCog,
  Zap,
} from "lucide-react";
import {
  customFetch,
  getGetAutomationRuleLogsQueryKey,
  getGetAutomationRulesQueryKey,
  useDeleteAutomationRule,
  useGetAutomationRules,
  useGetMe,
  useRunAutomationRule,
  useToggleAutomationRule,
  type AutomationAction,
  type AutomationRule,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { useToast } from "@/hooks/use-toast";
import { EmptyState, MiniStat, PageHeader, SectionCard } from "@/components/shared";
import { cn } from "@/lib/utils";
import { RuleBuilderDialog, RuleLogsDialog } from "@/components/automations/RuleDialogs";
import { ACTION_BY_VALUE, TRIGGERS, ruleSentence, triggerLabel } from "@/components/automations/workflowCopy";

const ACTION_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  create_task: CheckSquare,
  send_notification: Bell,
  send_email: Mail,
  send_sms: MessageSquare,
  change_contact_status: UserCog,
  enroll_sequence: ListOrdered,
  change_deal_stage: GitBranch,
};

/** Only the agency's owners may change rules (server: automation:create/update/delete). */
const EDITOR_ROLES = ["super_admin", "agency_admin"];

type RecentActivity = {
  recent: Array<{
    id: string;
    ruleId: string;
    ruleName: string;
    triggerEvent: string;
    matchedRecordType: string | null;
    result: "success" | "partial" | "failed";
    executedAt: string;
  }>;
  last24h: { success: number; partial: number; failed: number };
  total: number;
};

export default function WorkflowsPage() {
  const { data: me } = useGetMe();
  const canEdit = EDITOR_ROLES.includes(me?.role ?? "");
  const [createOpen, setCreateOpen] = useState(false);
  const [triggerFilter, setTriggerFilter] = useState("all");

  const { data, isLoading, isError } = useGetAutomationRules(
    triggerFilter !== "all" ? { triggerType: triggerFilter, limit: 200 } : { limit: 200 },
  );
  const activity = useQuery({
    queryKey: ["/api/automations/recent-activity"],
    queryFn: () => customFetch<RecentActivity>("/api/automations/recent-activity?limit=10"),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const rules = data?.rules ?? [];
  const total = data?.total ?? 0;
  const activeCount = rules.filter((r) => r.isActive).length;
  const totalRuns = rules.reduce((sum, r) => sum + (r.runCount ?? 0), 0);
  const last24 = activity.data?.last24h;
  const runs24 = last24 ? last24.success + last24.partial + last24.failed : 0;

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-7xl mx-auto">
      <PageHeader
        title="Workflow Automation"
        subtitle="Rules that create tasks, send emails and texts, and alert your team — automatically, when something happens"
      >
        {canEdit && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> New rule
          </Button>
        )}
      </PageHeader>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <MiniStat label={`Active rules (of ${total})`} value={activeCount} icon={Zap} loading={isLoading} tone="warning" />
        <MiniStat label="Runs in the last 24 hours" value={runs24} icon={Play} loading={activity.isLoading} tone="success" />
        <MiniStat
          label={last24 && last24.failed > 0 ? "Failed in the last 24 hours" : "Total runs, all time"}
          value={last24 && last24.failed > 0 ? last24.failed : totalRuns}
          icon={last24 && last24.failed > 0 ? AlertTriangle : CheckCircle2}
          tone={last24 && last24.failed > 0 ? "danger" : "default"}
          loading={isLoading || activity.isLoading}
        />
      </div>

      <SectionCard
        title="Automation rules"
        description="Each rule reads as a sentence: when this happens, do these steps. Switch a rule off to pause it."
        actions={
          <Select value={triggerFilter} onValueChange={setTriggerFilter}>
            <SelectTrigger className="h-9 w-[200px]" aria-label="Filter by trigger">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All triggers</SelectItem>
              {TRIGGERS.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
            </SelectContent>
          </Select>
        }
      >
        {isLoading ? (
          <div className="space-y-3">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-28 w-full rounded-lg" />)}</div>
        ) : isError ? (
          <EmptyState icon={Zap} title="Couldn't load your rules" description="Please refresh the page." />
        ) : rules.length === 0 ? (
          <EmptyState
            icon={Zap}
            title={triggerFilter === "all" ? "No automation rules yet" : "No rules use this trigger"}
            description="A rule does routine work for you — for example, when a new lead comes in, create a call task and send a welcome text."
            action={canEdit && triggerFilter === "all" ? { label: "Create your first rule", onClick: () => setCreateOpen(true) } : undefined}
          />
        ) : (
          <div className="space-y-3">
            {rules.map((rule) => <RuleRow key={rule.id} rule={rule} canEdit={canEdit} />)}
          </div>
        )}
      </SectionCard>

      <SectionCard title="Recent runs" description="The last few times any rule ran. Refreshes every 30 seconds." icon={Clock}>
        {activity.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : !activity.data || activity.data.recent.length === 0 ? (
          <EmptyState compact icon={Clock} title="Nothing has run yet" description="Rules run by themselves when their trigger happens." />
        ) : (
          <ul className="divide-y divide-border">
            {activity.data.recent.map((row) => (
              <li key={row.id} className="flex items-center gap-3 py-2 text-sm">
                {row.result === "success" ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
                ) : (
                  <AlertTriangle className={cn("h-4 w-4 shrink-0", row.result === "failed" ? "text-destructive" : "text-warning")} />
                )}
                <span className="font-medium truncate">{row.ruleName}</span>
                <span className="hidden sm:inline text-xs text-muted-foreground truncate">{triggerLabel(row.triggerEvent)}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                  {formatDistanceToNow(new Date(row.executedAt), { addSuffix: true })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {createOpen && <RuleBuilderDialog open={createOpen} onClose={() => setCreateOpen(false)} />}
    </div>
  );
}

function RuleRow({ rule, canEdit }: { rule: AutomationRule; canEdit: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { mutateAsync: toggle, isPending: toggling } = useToggleAutomationRule();
  const { mutateAsync: deleteRule } = useDeleteAutomationRule();
  const { mutateAsync: runRule, isPending: running } = useRunAutomationRule();
  const [editOpen, setEditOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const actions = (rule.actions as AutomationAction[] | null) ?? [];
  const sentence = ruleSentence(rule.triggerType, rule.triggerConfig as Record<string, unknown> | null, actions);

  const refresh = () => void qc.invalidateQueries({ queryKey: getGetAutomationRulesQueryKey() });

  const handleToggle = async () => {
    try {
      await toggle({ id: rule.id });
      refresh();
      toast({ title: rule.isActive ? "Rule paused" : "Rule switched on" });
    } catch {
      toast({ title: "Couldn't change the rule", variant: "destructive" });
    }
  };

  const handleRun = async () => {
    try {
      await runRule({ id: rule.id, data: {} });
      void qc.invalidateQueries({ queryKey: getGetAutomationRuleLogsQueryKey(rule.id) });
      toast({ title: "Rule queued", description: "It will run in the background in a moment." });
    } catch {
      toast({ title: "Couldn't run the rule", variant: "destructive" });
    }
  };

  const handleDelete = async () => {
    try {
      await deleteRule({ id: rule.id });
      refresh();
      toast({ title: "Rule deleted" });
    } catch {
      toast({ title: "Couldn't delete the rule", variant: "destructive" });
    }
  };

  return (
    <div className={cn("rounded-lg border border-border p-4 transition-opacity", !rule.isActive && "opacity-60")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={cn("h-2 w-2 shrink-0 rounded-full", rule.isActive ? "bg-success" : "bg-muted-foreground")} />
            <span className="text-sm font-semibold truncate">{rule.name}</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{sentence}</p>
        </div>
        <Switch
          checked={rule.isActive}
          onCheckedChange={() => void handleToggle()}
          disabled={!canEdit || toggling}
          aria-label={rule.isActive ? `Pause ${rule.name}` : `Switch on ${rule.name}`}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center rounded-full bg-secondary px-2.5 py-0.5 text-xs font-semibold text-secondary-foreground">
          {triggerLabel(rule.triggerType)}
        </span>
        <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
        {actions.map((a, i) => {
          const Icon = ACTION_ICONS[a.type] ?? Zap;
          return (
            <span key={i} className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-foreground">
              <Icon className="h-3 w-3" />
              {ACTION_BY_VALUE.get(a.type)?.label ?? a.type}
            </span>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 text-xs text-muted-foreground">
        <span>
          {rule.runCount > 0 ? `Ran ${rule.runCount} ${rule.runCount === 1 ? "time" : "times"}` : "Hasn't run yet"}
          {rule.lastRunAt && ` · last run ${formatDistanceToNow(new Date(rule.lastRunAt), { addSuffix: true })}`}
        </span>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setLogsOpen(true)}>
            <Clock className="mr-1 h-3.5 w-3.5" /> History
          </Button>
          {canEdit && (
            <>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => void handleRun()} disabled={running}>
                {running ? <RefreshCcw className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1 h-3.5 w-3.5" />}
                Run now
              </Button>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setEditOpen(true)}>
                <Pencil className="mr-1 h-3.5 w-3.5" /> Edit
              </Button>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)}>
                <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
              </Button>
            </>
          )}
        </div>
      </div>

      {editOpen && <RuleBuilderDialog open={editOpen} onClose={() => setEditOpen(false)} editRule={rule} />}
      {logsOpen && <RuleLogsDialog rule={rule} open={logsOpen} onClose={() => setLogsOpen(false)} />}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{rule.name}”?</AlertDialogTitle>
            <AlertDialogDescription>The rule stops running and its history is removed. This can't be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleDelete()}>Delete rule</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
