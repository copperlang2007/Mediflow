import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  SequenceWithStats,
  CreateSequenceBody, UpdateSequenceBody,
} from "@workspace/api-client-react";
import {
  useGetSequences, useCreateSequence, useUpdateSequence,
  useGetSequenceSteps, useCreateSequenceStep, useUpdateSequenceStep, useDeleteSequenceStep,
  getGetSequencesQueryKey,
  getGetSequenceStepsQueryKey,
  type SequenceStep,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Users, Plus, Workflow } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { SEQ_STATUS_STYLES } from "./shared";

// ──────────────────────────────────────────────
// Sequences Tab
// ──────────────────────────────────────────────

// ---------- Step builder dialog ----------

const STEP_TYPES: Array<{ value: "sms" | "email" | "task" | "wait"; label: string }> = [
  { value: "sms", label: "Send SMS" },
  { value: "email", label: "Send Email" },
  { value: "task", label: "Create Task" },
  { value: "wait", label: "Wait" },
];

function StepBuilderDialog({
  sequenceId,
  sequenceName,
  open,
  onClose,
}: {
  sequenceId: string;
  sequenceName: string;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data: stepsRaw, isLoading } = useGetSequenceSteps(sequenceId, {
    query: {
      queryKey: getGetSequenceStepsQueryKey(sequenceId),
      enabled: open,
    },
  });
  const { mutateAsync: createStep, isPending: creating } = useCreateSequenceStep();
  const { mutateAsync: updateStep } = useUpdateSequenceStep();
  const { mutateAsync: deleteStep } = useDeleteSequenceStep();
  const steps: SequenceStep[] = (stepsRaw ?? []) as SequenceStep[];

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: getGetSequenceStepsQueryKey(sequenceId) });

  const handleAdd = async (stepType: "sms" | "email" | "task" | "wait") => {
    const defaultConfig: Record<string, unknown> =
      stepType === "sms" ? { body: "" } :
      stepType === "email" ? { subject: "", body: "" } :
      stepType === "task" ? { title: "" } :
      {};
    const defaultDelay =
      stepType === "wait" ? { delayValue: 1, delayUnit: "days" as const } : { delayValue: 0, delayUnit: "days" as const };
    try {
      await createStep({
        id: sequenceId,
        data: { stepType, ...defaultDelay, config: defaultConfig },
      });
      void invalidate();
      void qc.invalidateQueries({ queryKey: getGetSequencesQueryKey() });
    } catch {
      toast.error("Failed to add step");
    }
  };

  const handleUpdate = async (
    stepId: string,
    patch: Partial<{
      delayValue: number;
      delayUnit: "minutes" | "hours" | "days";
      config: Record<string, unknown> | null;
    }>,
  ) => {
    try {
      await updateStep({ id: sequenceId, sid: stepId, data: patch });
      void invalidate();
    } catch {
      toast.error("Failed to update step");
    }
  };

  const handleDelete = async (stepId: string) => {
    if (!window.confirm("Remove this step?")) return;
    try {
      await deleteStep({ id: sequenceId, sid: stepId });
      void invalidate();
      void qc.invalidateQueries({ queryKey: getGetSequencesQueryKey() });
      toast.success("Step removed");
    } catch {
      toast.error("Failed to remove step");
    }
  };

  const handleReorder = async (stepId: string, direction: -1 | 1) => {
    const index = steps.findIndex((s) => s.id === stepId);
    const swapWith = steps[index + direction];
    if (!swapWith) return;
    try {
      await Promise.all([
        updateStep({ id: sequenceId, sid: stepId, data: { orderIndex: swapWith.orderIndex } }),
        updateStep({ id: sequenceId, sid: swapWith.id, data: { orderIndex: steps[index].orderIndex } }),
      ]);
      void invalidate();
    } catch {
      toast.error("Failed to reorder");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Steps for "{sequenceName}"</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {isLoading ? (
            <div className="space-y-2">
              {[...Array(3)].map((_, i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))}
            </div>
          ) : steps.length === 0 ? (
            <div className="border border-dashed rounded-lg py-8 text-center text-sm text-muted-foreground">
              No steps yet — add the first step below to start building this campaign.
            </div>
          ) : (
            steps.map((step, idx) => (
              <StepRow
                key={step.id}
                step={step}
                index={idx}
                isFirst={idx === 0}
                isLast={idx === steps.length - 1}
                onUpdate={(patch) => handleUpdate(step.id, patch)}
                onDelete={() => handleDelete(step.id)}
                onMoveUp={() => handleReorder(step.id, -1)}
                onMoveDown={() => handleReorder(step.id, 1)}
              />
            ))
          )}

          <div className="border rounded-lg p-3 bg-muted/30 space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Add a step
            </p>
            <div className="flex flex-wrap gap-2">
              {STEP_TYPES.map((t) => (
                <Button
                  key={t.value}
                  size="sm"
                  variant="outline"
                  disabled={creating}
                  onClick={() => handleAdd(t.value)}
                >
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  {t.label}
                </Button>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StepRow({
  step,
  index,
  isFirst,
  isLast,
  onUpdate,
  onDelete,
  onMoveUp,
  onMoveDown,
}: {
  step: SequenceStep;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  onUpdate: (patch: {
    delayValue?: number;
    delayUnit?: "minutes" | "hours" | "days";
    config?: Record<string, unknown> | null;
  }) => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const config = (step.config ?? {}) as Record<string, unknown>;
  const setCfg = (patch: Record<string, unknown>) => onUpdate({ config: { ...config, ...patch } });

  const STEP_TYPE_LABELS: Record<string, string> = {
    sms: "Send SMS",
    email: "Send Email",
    task: "Create Task",
    wait: "Wait",
  };

  return (
    <div className="border rounded-lg p-3 space-y-2 bg-card">
      <div className="flex items-center gap-2">
        <span className="text-xs font-mono text-muted-foreground w-6 shrink-0">{index + 1}.</span>
        <span className="font-medium text-sm">{STEP_TYPE_LABELS[step.stepType] ?? step.stepType}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            disabled={isFirst}
            onClick={onMoveUp}
            title="Move up"
          >
            <span aria-hidden>↑</span>
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            disabled={isLast}
            onClick={onMoveDown}
            title="Move down"
          >
            <span aria-hidden>↓</span>
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-destructive hover:text-destructive"
            onClick={onDelete}
            title="Delete"
          >
            <span aria-hidden>×</span>
          </Button>
        </div>
      </div>

      {/* Delay */}
      {step.stepType !== "wait" && index > 0 && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">After</span>
          <Input
            type="number"
            min={0}
            value={step.delayValue}
            onChange={(e) => onUpdate({ delayValue: parseInt(e.target.value || "0", 10) })}
            className="h-7 text-xs w-20"
          />
          <Select
            value={step.delayUnit}
            onValueChange={(v) => onUpdate({ delayUnit: v as "minutes" | "hours" | "days" })}
          >
            <SelectTrigger className="h-7 text-xs w-28"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="minutes">minutes</SelectItem>
              <SelectItem value="hours">hours</SelectItem>
              <SelectItem value="days">days</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Step type-specific config */}
      {step.stepType === "sms" && (
        <Textarea
          rows={2}
          placeholder="SMS message body…"
          value={String(config.body ?? "")}
          onChange={(e) => setCfg({ body: e.target.value })}
          className="text-xs"
        />
      )}
      {step.stepType === "email" && (
        <div className="space-y-2">
          <Input
            placeholder="Subject"
            value={String(config.subject ?? "")}
            onChange={(e) => setCfg({ subject: e.target.value })}
            className="h-7 text-xs"
          />
          <Textarea
            rows={3}
            placeholder="Email body (HTML allowed)…"
            value={String(config.body ?? "")}
            onChange={(e) => setCfg({ body: e.target.value })}
            className="text-xs"
          />
        </div>
      )}
      {step.stepType === "task" && (
        <Input
          placeholder="Task title"
          value={String(config.title ?? "")}
          onChange={(e) => setCfg({ title: e.target.value })}
          className="h-7 text-xs"
        />
      )}
      {step.stepType === "wait" && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Wait</span>
          <Input
            type="number"
            min={1}
            value={step.delayValue}
            onChange={(e) => onUpdate({ delayValue: parseInt(e.target.value || "0", 10) })}
            className="h-7 text-xs w-20"
          />
          <Select
            value={step.delayUnit}
            onValueChange={(v) => onUpdate({ delayUnit: v as "minutes" | "hours" | "days" })}
          >
            <SelectTrigger className="h-7 text-xs w-28"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="minutes">minutes</SelectItem>
              <SelectItem value="hours">hours</SelectItem>
              <SelectItem value="days">days</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-muted-foreground">before next step</span>
        </div>
      )}
    </div>
  );
}

export default function SequencesTab() {
  const qc = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [stepsForSeq, setStepsForSeq] = useState<{ id: string; name: string } | null>(null);
  const [form, setForm] = useState<CreateSequenceBody>({ name: "", description: undefined, triggerType: "manual", status: "draft" });

  const { data: sequencesRaw, isLoading } = useGetSequences();
  const { mutateAsync: createSequence, isPending } = useCreateSequence();
  const { mutateAsync: updateSequence } = useUpdateSequence();

  const sequences: SequenceWithStats[] = sequencesRaw ?? [];

  const handleCreate = async () => {
    if (!form.name) { toast.error("Name required"); return; }
    try {
      await createSequence({ data: form });
      toast.success("Sequence created");
      setAddOpen(false);
      void qc.invalidateQueries({ queryKey: getGetSequencesQueryKey() });
    } catch { toast.error("Failed to create sequence"); }
  };

  const toggleStatus = async (id: string, current: string) => {
    const next = current === "active" ? "paused" : "active";
    await updateSequence({ id, data: { status: next } satisfies UpdateSequenceBody });
    void qc.invalidateQueries({ queryKey: getGetSequencesQueryKey() });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Button size="sm" onClick={() => setAddOpen(true)}><Plus className="h-4 w-4 mr-1" />New Sequence</Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-16 rounded-lg" />)}</div>
      ) : sequences.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Workflow className="h-12 w-12 text-muted-foreground/20 mb-3" />
          <p className="font-medium text-muted-foreground">No sequences yet</p>
          <p className="text-sm text-muted-foreground/70 mt-1">Build automated outreach workflows</p>
        </div>
      ) : (
        <div className="space-y-2">
          {sequences.map(({ sequence, stepCount, activeEnrollments }: SequenceWithStats) => (
            <div key={sequence.id} className="flex items-center gap-4 p-4 rounded-xl border bg-card hover:bg-muted/20 transition-colors">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="font-medium">{sequence.name}</p>
                  <Badge className={cn("text-xs border-0", SEQ_STATUS_STYLES[sequence.status] ?? "")}>{sequence.status}</Badge>
                </div>
                <div className="flex items-center gap-4 text-xs text-muted-foreground mt-0.5">
                  <span><Workflow className="h-3 w-3 inline mr-1" />{stepCount} steps</span>
                  <span><Users className="h-3 w-3 inline mr-1" />{activeEnrollments} enrolled</span>
                  <span className="capitalize">Trigger: {(sequence.triggerType ?? "manual").replace(/_/g, " ")}</span>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs shrink-0"
                onClick={() => setStepsForSeq({ id: sequence.id, name: sequence.name })}
              >
                Edit steps
              </Button>
              <Button variant="outline" size="sm" className="h-7 text-xs shrink-0" onClick={() => toggleStatus(sequence.id, sequence.status)}>
                {sequence.status === "active" ? "Pause" : "Activate"}
              </Button>
            </div>
          ))}
        </div>
      )}

      {stepsForSeq && (
        <StepBuilderDialog
          sequenceId={stepsForSeq.id}
          sequenceName={stepsForSeq.name}
          open={!!stepsForSeq}
          onClose={() => setStepsForSeq(null)}
        />
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>New Sequence</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5"><Label>Name *</Label><Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></div>
            <div className="space-y-1.5"><Label>Description</Label><Textarea rows={2} value={form.description ?? ""} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value || null }))} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Trigger</Label>
                <Select value={form.triggerType ?? "manual"} onValueChange={(v) => setForm((f) => ({ ...f, triggerType: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual">Manual</SelectItem>
                    <SelectItem value="lead_created">Lead Created</SelectItem>
                    <SelectItem value="enrolled">Enrolled</SelectItem>
                    <SelectItem value="birthday">Birthday</SelectItem>
                    <SelectItem value="plan_anniversary">Plan Anniversary</SelectItem>
                    <SelectItem value="aep_start">AEP Start</SelectItem>
                    <SelectItem value="oep_start">OEP Start</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Initial Status</Label>
                <Select value={form.status ?? "draft"} onValueChange={(v) => setForm((f) => ({ ...f, status: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="draft">Draft</SelectItem>
                    <SelectItem value="active">Active</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={isPending}>{isPending ? "Creating…" : "Create Sequence"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
