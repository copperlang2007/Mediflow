import { useState, useCallback } from "react";
import { useParams, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";
import type {
  Contact, Activity, GetContactTasks200Item, GetContactEnrollments200Item,
  GetDeals200Item, PipelineWithStages, UpdateContactBody,
  SendContactSmsBody, SendContactEmailBody, LogActivityBody,
  CreateDealBody,
} from "@workspace/api-client-react";
import {
  useGetContact, useUpdateContact,
  useGetContactActivities, useLogContactActivity,
  useGetContactTasks, useGetContactEnrollments,
  useSendContactSms, useSendContactEmail,
  useGetDeals, useCreateDeal,
  useGetPipelines,
  getGetContactQueryKey, getGetContactActivitiesQueryKey,
  getGetDealsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  ArrowLeft, Mail, MessageSquare, Plus, Send,
  StickyNote, PhoneCall, Activity as ActivityIcon, CheckSquare, FolderOpen,
  Workflow, Heart, Calendar,
  Shield, DollarSign, Clock, Edit, User, MapPin, Sparkles, Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { format, formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

const CONTACT_STATUS_STYLES: Record<string, string> = {
  lead: "bg-blue-100 text-blue-800",
  prospect: "bg-purple-100 text-purple-800",
  enrolled: "bg-green-100 text-green-800",
  retained: "bg-emerald-100 text-emerald-800",
  lost: "bg-red-100 text-red-800",
  do_not_contact: "bg-slate-100 text-slate-600",
};

const PLAN_TYPE_LABELS: Record<string, string> = {
  MA: "Medicare Advantage", PDP: "Part D", MAPD: "MAPD", supp: "Supplement", other: "Other",
};

const ACTIVITY_ICONS: Record<string, React.ReactNode> = {
  note: <StickyNote className="h-4 w-4 text-amber-500" />,
  call_log: <PhoneCall className="h-4 w-4 text-blue-500" />,
  sms: <MessageSquare className="h-4 w-4 text-green-500" />,
  email: <Mail className="h-4 w-4 text-purple-500" />,
  status_change: <ActivityIcon className="h-4 w-4 text-slate-500" />,
  enrollment: <Shield className="h-4 w-4 text-emerald-500" />,
  task_complete: <CheckSquare className="h-4 w-4 text-teal-500" />,
  document_upload: <FolderOpen className="h-4 w-4 text-orange-500" />,
  sequence_enrolled: <Workflow className="h-4 w-4 text-indigo-500" />,
  sequence_step: <Workflow className="h-4 w-4 text-indigo-400" />,
};

function initials(first: string, last: string) {
  return `${first?.[0] ?? ""}${last?.[0] ?? ""}`.toUpperCase();
}

// ──────────────────────────────────────────────
// Modals
// ──────────────────────────────────────────────

function useDraftWithAi(contactId: string, type: "sms" | "email") {
  const { getToken } = useAuth();
  const [drafting, setDrafting] = useState(false);
  const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

  const draft = useCallback(async (goal?: string): Promise<{ subject?: string; body: string } | null> => {
    setDrafting(true);
    try {
      const token = await getToken();
      const res = await fetch(`${base}/api/ai/draft`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ contactId, channel: type, goal: goal || "follow up about Medicare coverage" }),
      });
      if (!res.ok) throw new Error("Draft failed");
      const data = await res.json() as { draft?: string; subject?: string; body?: string };
      return { body: data.draft ?? data.body ?? "", subject: data.subject };
    } catch {
      toast.error("AI draft failed — try again");
      return null;
    } finally {
      setDrafting(false);
    }
  }, [contactId, type, getToken, base]);

  return { draft, drafting };
}

function SendSmsModal({ contactId, contactName, open, onClose }: { contactId: string; contactName: string; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [body, setBody] = useState("");
  const [aiDrafted, setAiDrafted] = useState(false);
  const { mutateAsync: sendSms, isPending } = useSendContactSms();
  const { draft, drafting } = useDraftWithAi(contactId, "sms");

  const handleDraft = async () => {
    const result = await draft(`Follow up with ${contactName} about Medicare coverage`);
    if (result) { setBody(result.body); setAiDrafted(true); }
  };

  const send = async () => {
    if (!body.trim()) return;
    try {
      await sendSms({ id: contactId, data: { body, aiAssisted: aiDrafted } as SendContactSmsBody });
      toast.success("SMS sent");
      setBody("");
      setAiDrafted(false);
      onClose();
      void qc.invalidateQueries({ queryKey: getGetContactActivitiesQueryKey(contactId) });
    } catch (e) {
      toast.error((e as Error)?.message ?? "Failed to send SMS");
    }
  };
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Send SMS to {contactName}</DialogTitle></DialogHeader>
        <Textarea placeholder="Type your message…" rows={4} value={body} onChange={(e) => setBody(e.target.value)} maxLength={1600} />
        <div className="flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={handleDraft} disabled={drafting} className="text-xs text-muted-foreground hover:text-foreground">
            {drafting ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Sparkles className="h-3 w-3 mr-1" />}
            {drafting ? "Drafting…" : "Draft with AI"}
          </Button>
          <p className="text-xs text-muted-foreground">{body.length}/1600</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={send} disabled={isPending || !body.trim()}>
            <Send className="h-4 w-4 mr-1" />{isPending ? "Sending…" : "Send SMS"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SendEmailModal({ contactId, contactName, open, onClose }: { contactId: string; contactName: string; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<SendContactEmailBody>({ subject: "", body: "" });
  const [aiDrafted, setAiDrafted] = useState(false);
  const { mutateAsync: sendEmail, isPending } = useSendContactEmail();
  const { draft, drafting } = useDraftWithAi(contactId, "email");

  const handleDraft = async () => {
    const result = await draft(`Follow up with ${contactName} about Medicare coverage options`);
    if (result) { setForm({ subject: result.subject ?? "", body: result.body }); setAiDrafted(true); }
  };

  const send = async () => {
    if (!form.subject || !form.body) return;
    try {
      await sendEmail({ id: contactId, data: { ...form, aiAssisted: aiDrafted } as SendContactEmailBody });
      toast.success("Email sent");
      setForm({ subject: "", body: "" });
      setAiDrafted(false);
      onClose();
      void qc.invalidateQueries({ queryKey: getGetContactActivitiesQueryKey(contactId) });
    } catch (e) {
      toast.error((e as Error)?.message ?? "Failed to send email");
    }
  };
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle>Send Email to {contactName}</DialogTitle>
            <Button variant="ghost" size="sm" onClick={handleDraft} disabled={drafting} className="text-xs text-muted-foreground hover:text-foreground -mr-1">
              {drafting ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Sparkles className="h-3 w-3 mr-1" />}
              {drafting ? "Drafting…" : "Draft with AI"}
            </Button>
          </div>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5"><Label>Subject</Label><Input value={form.subject} onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))} /></div>
          <div className="space-y-1.5"><Label>Message</Label><Textarea rows={6} value={form.body} onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={send} disabled={isPending || !form.subject || !form.body}>
            <Send className="h-4 w-4 mr-1" />{isPending ? "Sending…" : "Send Email"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LogActivityModal({ contactId, open, onClose }: { contactId: string; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<LogActivityBody>({ type: "note", body: "" });
  const { mutateAsync: logActivity, isPending } = useLogContactActivity();
  const save = async () => {
    if (!form.body?.trim()) return;
    try {
      await logActivity({ id: contactId, data: form });
      toast.success("Activity logged");
      setForm({ type: "note", body: "" });
      onClose();
      void qc.invalidateQueries({ queryKey: getGetContactActivitiesQueryKey(contactId) });
    } catch { toast.error("Failed to log activity"); }
  };
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Log Activity</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Type</Label>
            <Select value={form.type} onValueChange={(v) => setForm((f) => ({ ...f, type: v as LogActivityBody["type"] }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="note">Note</SelectItem>
                <SelectItem value="call_log">Call Log</SelectItem>
                <SelectItem value="task_complete">Task Completed</SelectItem>
                <SelectItem value="enrollment">Enrollment</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5"><Label>Details</Label><Textarea rows={4} value={form.body ?? ""} onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={isPending || !form.body?.trim()}>{isPending ? "Saving…" : "Log Activity"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ──────────────────────────────────────────────
// Timeline Tab
// ──────────────────────────────────────────────

function TimelineTab({ contactId }: { contactId: string }) {
  const [logOpen, setLogOpen] = useState(false);
  const { data: activitiesRaw, isLoading } = useGetContactActivities(contactId, { limit: 100 });
  const activities: Activity[] = activitiesRaw ?? [];

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={() => setLogOpen(true)}><Plus className="h-4 w-4 mr-1" />Log Activity</Button>
      </div>
      {isLoading ? (
        <div className="space-y-3">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-16 rounded-lg" />)}</div>
      ) : activities.length === 0 ? (
        <div className="text-center py-12 text-sm text-muted-foreground">No activity yet — log a note or make contact to get started.</div>
      ) : (
        <div className="relative">
          <div className="absolute left-5 top-0 bottom-0 w-px bg-border" />
          <div className="space-y-4">
            {activities.map((act) => (
              <div key={act.id} className="flex gap-4">
                <div className="relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border bg-background shadow-sm">
                  {ACTIVITY_ICONS[act.type] ?? <ActivityIcon className="h-4 w-4 text-muted-foreground" />}
                </div>
                <div className="flex-1 pb-2">
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium capitalize">{act.type.replace(/_/g, " ")}</p>
                      {act.body && <p className="text-sm text-muted-foreground mt-0.5 whitespace-pre-line">{act.body}</p>}
                    </div>
                    <p className="text-xs text-muted-foreground shrink-0 mt-0.5">{formatDistanceToNow(new Date(act.createdAt))} ago</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <LogActivityModal contactId={contactId} open={logOpen} onClose={() => setLogOpen(false)} />
    </div>
  );
}

// ──────────────────────────────────────────────
// Deals Tab
// ──────────────────────────────────────────────

function DealsTab({ contactId }: { contactId: string }) {
  const qc = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState<CreateDealBody>({ pipelineId: "", stageId: "", contactId, title: "", valueEst: null });

  const { data: dealsRaw, isLoading } = useGetDeals({ contactId, limit: 50 });
  const { data: pipelinesRaw } = useGetPipelines();
  const { mutateAsync: createDeal } = useCreateDeal();

  const deals: GetDeals200Item[] = dealsRaw ?? [];
  const pipelines: PipelineWithStages[] = pipelinesRaw ?? [];
  const selectedPipeline = pipelines.find((p) => p.id === form.pipelineId);

  const handleCreate = async () => {
    if (!form.pipelineId || !form.stageId || !form.title) { toast.error("Pipeline, stage, and title required"); return; }
    try {
      await createDeal({ data: form });
      toast.success("Deal created");
      setAddOpen(false);
      void qc.invalidateQueries({ queryKey: getGetDealsQueryKey() });
    } catch { toast.error("Failed to create deal"); }
  };

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}><Plus className="h-4 w-4 mr-1" />New Deal</Button>
      </div>
      {isLoading ? (
        <div className="space-y-2">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-14 rounded-lg" />)}</div>
      ) : deals.length === 0 ? (
        <div className="text-center py-10 text-sm text-muted-foreground">No deals yet</div>
      ) : (
        <div className="space-y-2">
          {deals.map((rowRaw) => {
            const row = rowRaw as Record<string, unknown>;
            const deal = row.deal as Record<string, unknown> | undefined;
            if (!deal) return null;
            const dealStatus = String(deal.status ?? "open");
            const statusColor = dealStatus === "won" ? "text-green-600" : dealStatus === "lost" ? "text-red-600" : "text-blue-600";
            return (
              <div key={String(deal.id)} className="flex items-center gap-4 p-4 rounded-xl border bg-card">
                <div className="flex-1">
                  <p className="font-medium text-sm">{String(deal.title)}</p>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                    <span className={cn("font-medium capitalize", statusColor)}>{dealStatus}</span>
                    {deal.valueEst != null && <span><DollarSign className="h-3 w-3 inline" />{Number(deal.valueEst).toLocaleString()}</span>}
                    <span><Clock className="h-3 w-3 inline mr-0.5" />{format(new Date(String(deal.createdAt)), "MMM d, yyyy")}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>New Deal</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5"><Label>Title *</Label><Input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} /></div>
            <div className="space-y-1.5">
              <Label>Pipeline *</Label>
              <Select value={form.pipelineId} onValueChange={(v) => setForm((f) => ({ ...f, pipelineId: v, stageId: "" }))}>
                <SelectTrigger><SelectValue placeholder="Select pipeline…" /></SelectTrigger>
                <SelectContent>{pipelines.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            {selectedPipeline && selectedPipeline.stages.length > 0 && (
              <div className="space-y-1.5">
                <Label>Stage *</Label>
                <Select value={form.stageId} onValueChange={(v) => setForm((f) => ({ ...f, stageId: v }))}>
                  <SelectTrigger><SelectValue placeholder="Select stage…" /></SelectTrigger>
                  <SelectContent>{selectedPipeline.stages.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1.5">
              <Label>Estimated Value ($)</Label>
              <Input type="number" value={form.valueEst ?? ""} onChange={(e) => setForm((f) => ({ ...f, valueEst: e.target.value ? parseFloat(e.target.value) : null }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate}>Create Deal</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ──────────────────────────────────────────────
// Tasks Tab
// ──────────────────────────────────────────────

function TasksTab({ contactId }: { contactId: string }) {
  const { data: tasksRaw, isLoading } = useGetContactTasks(contactId);
  const tasks: GetContactTasks200Item[] = tasksRaw ?? [];

  const STATUS_STYLES: Record<string, string> = {
    open: "bg-blue-100 text-blue-800",
    in_progress: "bg-amber-100 text-amber-800",
    completed: "bg-green-100 text-green-800",
    cancelled: "bg-slate-100 text-slate-600",
  };

  return (
    <div>
      {isLoading ? (
        <div className="space-y-2">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-14 rounded-lg" />)}</div>
      ) : tasks.length === 0 ? (
        <div className="text-center py-10 text-sm text-muted-foreground">No tasks assigned to this contact</div>
      ) : (
        <div className="space-y-2">
          {tasks.map((taskRaw) => {
            const t = taskRaw as Record<string, unknown>;
            const status = String(t.status ?? "open");
            return (
              <div key={String(t.id)} className="flex items-center gap-3 p-3 rounded-lg border bg-card">
                <CheckSquare className="h-5 w-5 text-muted-foreground shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-medium">{String(t.title ?? "")}</p>
                  {t.dueDate != null && <p className="text-xs text-muted-foreground">Due {format(new Date(String(t.dueDate)), "MMM d, yyyy")}</p>}
                </div>
                <Badge className={cn("text-xs border-0", STATUS_STYLES[status] ?? "")}>{status}</Badge>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────
// Sequences Tab
// ──────────────────────────────────────────────

function SequencesTab({ contactId }: { contactId: string }) {
  const { data: enrollmentsRaw, isLoading } = useGetContactEnrollments(contactId);
  const enrollments: GetContactEnrollments200Item[] = enrollmentsRaw ?? [];

  const STATUS_STYLES: Record<string, string> = {
    active: "bg-green-100 text-green-800",
    completed: "bg-slate-100 text-slate-600",
    cancelled: "bg-red-100 text-red-800",
    paused: "bg-amber-100 text-amber-800",
  };

  return (
    <div>
      {isLoading ? (
        <div className="space-y-2">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-14 rounded-lg" />)}</div>
      ) : enrollments.length === 0 ? (
        <div className="text-center py-10 text-sm text-muted-foreground">Not enrolled in any sequences</div>
      ) : (
        <div className="space-y-2">
          {enrollments.map((rowRaw) => {
            const row = rowRaw as Record<string, unknown>;
            const enroll = row.enrollment as Record<string, unknown> | undefined;
            if (!enroll) return null;
            const status = String(enroll.status ?? "active");
            return (
              <div key={String(enroll.id)} className="flex items-center gap-3 p-3 rounded-lg border bg-card">
                <Workflow className="h-5 w-5 text-indigo-500 shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-medium">{String(row.sequenceName ?? "Unknown Sequence")}</p>
                  <p className="text-xs text-muted-foreground">
                    Step {Number(enroll.nextStepIndex ?? 0)} · Enrolled {formatDistanceToNow(new Date(String(enroll.enrolledAt)))} ago
                  </p>
                </div>
                <Badge className={cn("text-xs border-0", STATUS_STYLES[status] ?? "")}>{status}</Badge>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────
// Main Contact Detail Page
// ──────────────────────────────────────────────

export default function ContactDetailPage() {
  const [, nav] = useLocation();
  const params = useParams<{ id: string }>();
  const id = params.id;
  const qc = useQueryClient();

  const [smsOpen, setSmsOpen] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState<UpdateContactBody>({});

  const { data: contactRaw, isLoading } = useGetContact(id);
  const { mutateAsync: updateContact } = useUpdateContact();

  if (isLoading) {
    return (
      <div className="p-6 max-w-5xl mx-auto space-y-4">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-28 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    );
  }

  if (!contactRaw) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <Button variant="ghost" size="sm" onClick={() => nav("/crm")}><ArrowLeft className="h-4 w-4 mr-1" />Back to CRM</Button>
        <div className="mt-8 text-center text-muted-foreground">Contact not found</div>
      </div>
    );
  }

  const c = contactRaw as Contact;
  const contactName = `${c.firstName} ${c.lastName}`.trim();

  const openEdit = () => {
    setEditForm({
      firstName: c.firstName,
      lastName: c.lastName,
      email: c.email,
      phone: c.phone,
      medicareId: c.medicareId,
      currentPlanType: c.currentPlanType,
      planYear: c.planYear,
      stateCode: c.stateCode,
      zipCode: c.zipCode,
      county: c.county,
      leadSource: c.leadSource,
      status: c.status,
    });
    setEditOpen(true);
  };

  const saveEdit = async () => {
    try {
      await updateContact({ id, data: editForm });
      toast.success("Contact updated");
      setEditOpen(false);
      void qc.invalidateQueries({ queryKey: getGetContactQueryKey(id) });
    } catch { toast.error("Failed to update contact"); }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <Button variant="ghost" size="sm" className="-ml-2" onClick={() => nav("/crm")}>
        <ArrowLeft className="h-4 w-4 mr-1" />Back to CRM
      </Button>

      {/* Contact Header */}
      <div className="rounded-2xl border bg-card p-6">
        <div className="flex flex-wrap items-start gap-6">
          <Avatar className="h-16 w-16 shrink-0">
            <AvatarFallback className="text-xl bg-primary/10 text-primary">{initials(c.firstName, c.lastName)}</AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-3 mb-1">
              <h1 className="text-2xl font-bold">{contactName}</h1>
              <Badge className={cn("text-sm border-0", CONTACT_STATUS_STYLES[c.status] ?? "")}>{c.status.replace(/_/g, " ")}</Badge>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-1 text-sm text-muted-foreground mt-2">
              {c.phone && <span>📞 {c.phone}</span>}
              {c.email && <span className="flex items-center gap-1"><Mail className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{c.email}</span></span>}
              {c.medicareId && <span className="flex items-center gap-1"><Shield className="h-3.5 w-3.5" />ID: {c.medicareId}</span>}
              {c.dob && <span className="flex items-center gap-1"><Calendar className="h-3.5 w-3.5" />DOB: {format(new Date(c.dob), "MMM d, yyyy")}</span>}
              {c.currentPlanType && <span className="flex items-center gap-1"><Heart className="h-3.5 w-3.5" />{PLAN_TYPE_LABELS[c.currentPlanType] ?? c.currentPlanType}{c.planYear ? ` (${c.planYear})` : ""}</span>}
              {(c.county || c.stateCode) && <span className="flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{[c.county, c.stateCode].filter(Boolean).join(", ")}</span>}
              {c.leadSource && <span className="flex items-center gap-1"><User className="h-3.5 w-3.5" />Source: {c.leadSource}</span>}
            </div>
            {c.tags && c.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-3">
                {c.tags.map((tag) => <span key={tag} className="text-xs bg-muted px-2 py-0.5 rounded-full">{tag}</span>)}
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2 shrink-0">
            {c.phone && !c.optOutSms && <Button size="sm" variant="outline" onClick={() => setSmsOpen(true)}><MessageSquare className="h-4 w-4 mr-1" />SMS</Button>}
            {c.email && !c.optOutEmail && <Button size="sm" variant="outline" onClick={() => setEmailOpen(true)}><Mail className="h-4 w-4 mr-1" />Email</Button>}
            <Button size="sm" variant="outline" onClick={() => setLogOpen(true)}><ActivityIcon className="h-4 w-4 mr-1" />Log</Button>
            <Button size="sm" variant="outline" onClick={openEdit}><Edit className="h-4 w-4 mr-1" />Edit</Button>
          </div>
        </div>
        {(c.optOutSms || c.optOutEmail) && (
          <div className="mt-4 flex flex-wrap gap-2">
            {c.optOutSms && <Badge variant="destructive" className="text-xs">SMS Opt-Out</Badge>}
            {c.optOutEmail && <Badge variant="destructive" className="text-xs">Email Opt-Out</Badge>}
          </div>
        )}
      </div>

      {/* Tabs */}
      <Tabs defaultValue="timeline" className="space-y-4">
        <TabsList>
          <TabsTrigger value="timeline"><ActivityIcon className="h-4 w-4 mr-1" />Timeline</TabsTrigger>
          <TabsTrigger value="deals"><DollarSign className="h-4 w-4 mr-1" />Deals</TabsTrigger>
          <TabsTrigger value="tasks"><CheckSquare className="h-4 w-4 mr-1" />Tasks</TabsTrigger>
          <TabsTrigger value="sequences"><Workflow className="h-4 w-4 mr-1" />Sequences</TabsTrigger>
        </TabsList>
        <TabsContent value="timeline"><TimelineTab contactId={id} /></TabsContent>
        <TabsContent value="deals"><DealsTab contactId={id} /></TabsContent>
        <TabsContent value="tasks"><TasksTab contactId={id} /></TabsContent>
        <TabsContent value="sequences"><SequencesTab contactId={id} /></TabsContent>
      </Tabs>

      {/* Modals */}
      <SendSmsModal contactId={id} contactName={contactName} open={smsOpen} onClose={() => setSmsOpen(false)} />
      <SendEmailModal contactId={id} contactName={contactName} open={emailOpen} onClose={() => setEmailOpen(false)} />
      <LogActivityModal contactId={id} open={logOpen} onClose={() => setLogOpen(false)} />

      {/* Edit Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Edit Contact</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-3 py-2">
            {([
              { key: "firstName", label: "First Name" },
              { key: "lastName", label: "Last Name" },
              { key: "email", label: "Email" },
              { key: "phone", label: "Phone" },
              { key: "medicareId", label: "Medicare ID" },
              { key: "planYear", label: "Plan Year", type: "number" },
              { key: "stateCode", label: "State", maxLength: 2 },
              { key: "zipCode", label: "ZIP Code" },
              { key: "county", label: "County" },
              { key: "leadSource", label: "Lead Source" },
            ] as Array<{ key: keyof UpdateContactBody; label: string; type?: string; maxLength?: number }>).map(({ key, label, type, maxLength }) => (
              <div key={key} className="space-y-1.5">
                <Label>{label}</Label>
                <Input
                  type={type ?? "text"}
                  maxLength={maxLength}
                  value={String(editForm[key] ?? "")}
                  onChange={(e) => setEditForm((f) => ({ ...f, [key]: e.target.value || null }))}
                />
              </div>
            ))}
            <div className="space-y-1.5">
              <Label>Plan Type</Label>
              <Select value={String(editForm.currentPlanType ?? "")} onValueChange={(v) => setEditForm((f) => ({ ...f, currentPlanType: v || null }))}>
                <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="">None</SelectItem>
                  {Object.entries(PLAN_TYPE_LABELS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select value={String(editForm.status ?? c.status)} onValueChange={(v) => setEditForm((f) => ({ ...f, status: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="lead">Lead</SelectItem>
                  <SelectItem value="prospect">Prospect</SelectItem>
                  <SelectItem value="enrolled">Enrolled</SelectItem>
                  <SelectItem value="retained">Retained</SelectItem>
                  <SelectItem value="lost">Lost</SelectItem>
                  <SelectItem value="do_not_contact">Do Not Contact</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button onClick={saveEdit}>Save Changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
