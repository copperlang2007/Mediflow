import { useState, useCallback, useEffect } from "react";
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
  customFetch,
  getGetContactQueryKey, getGetContactActivitiesQueryKey,
  getGetDealsQueryKey,
} from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
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
import {
  ArrowLeft, Mail, MessageSquare, Plus, Send,
  StickyNote, PhoneCall, Activity as ActivityIcon, CheckSquare, FolderOpen,
  Workflow, Heart, Calendar,
  Shield, DollarSign, Clock, Edit, User, MapPin, Sparkles, Loader2,
  Phone, AlertTriangle, ListChecks, FileText,
} from "lucide-react";
import { toast } from "sonner";
import { format, formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import CreateLeadDialog from "@/pages/crm/CreateLeadDialog";
import ApplicationsTab from "@/pages/crm/ApplicationsTab";
import { ContactAvatar } from "@/pages/crm/ui";
import { EmptyState, SectionCard, StatusPill } from "@/components/shared";
import { BookAppointmentButton } from "@/components/calendar/BookAppointmentButton";
import {
  useContactCallSummaries,
  type CallSummary,
  type SuggestedDisposition,
} from "@/lib/crm/callSummaries";
import { formatPhone } from "@/lib/phone";

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

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

  useEffect(() => {
    const handler = (e: Event) => {
      const { content, draftType } = (e as CustomEvent<{ content: string; draftType: string }>).detail;
      if (draftType === "sms") { setBody(content); setAiDrafted(true); }
    };
    window.addEventListener("mediflow:insert-draft", handler);
    return () => window.removeEventListener("mediflow:insert-draft", handler);
  }, []);

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

  useEffect(() => {
    const handler = (e: Event) => {
      const { content, draftType } = (e as CustomEvent<{ content: string; draftType: string }>).detail;
      if (draftType === "email") { setForm((f) => ({ ...f, body: content })); setAiDrafted(true); }
    };
    window.addEventListener("mediflow:insert-draft", handler);
    return () => window.removeEventListener("mediflow:insert-draft", handler);
  }, []);

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

type ContactMessage = {
  id: string;
  threadId: string;
  channel: "sms" | "email";
  direction: "inbound" | "outbound";
  body: string | null;
  subject: string | null;
  fromAddress: string | null;
  toAddress: string | null;
  status: string;
  sentAt: string | null;
  createdAt: string;
};

type TimelineEntry =
  | { kind: "activity"; id: string; at: Date; activity: Activity }
  | { kind: "message"; id: string; at: Date; message: ContactMessage };

function TimelineTab({ contactId }: { contactId: string }) {
  const [logOpen, setLogOpen] = useState(false);
  const { data: activitiesRaw, isLoading: activitiesLoading } = useGetContactActivities(
    contactId,
    { limit: 100 },
  );
  const activities: Activity[] = activitiesRaw ?? [];

  // Pull messages (SMS + email) for this contact and merge them into the
  // timeline so the user sees the full communication history in one stream.
  const { data: messagesData, isLoading: messagesLoading } = useQuery({
    queryKey: ["/api/contacts", contactId, "messages"],
    queryFn: () =>
      customFetch<{ messages: ContactMessage[]; total: number }>(
        `/api/contacts/${contactId}/messages?limit=200`,
      ),
    staleTime: 30_000,
  });
  const messages: ContactMessage[] = messagesData?.messages ?? [];

  const isLoading = activitiesLoading || messagesLoading;

  const entries: TimelineEntry[] = [
    ...activities.map((a): TimelineEntry => ({
      kind: "activity",
      id: a.id,
      at: new Date(a.createdAt),
      activity: a,
    })),
    ...messages.map((m): TimelineEntry => ({
      kind: "message",
      id: m.id,
      at: new Date(m.sentAt ?? m.createdAt),
      message: m,
    })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end gap-3">
        <span className="text-xs text-muted-foreground">
          {messages.length} message{messages.length !== 1 ? "s" : ""} · {activities.length} activit
          {activities.length !== 1 ? "ies" : "y"}
        </span>
        <Button size="sm" variant="outline" onClick={() => setLogOpen(true)}>
          <Plus className="h-4 w-4 mr-1" />
          Log Activity
        </Button>
      </div>
      {isLoading ? (
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-16 rounded-lg" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          compact
          icon={ActivityIcon}
          title="Nothing logged yet"
          description="Calls, notes, texts and emails with this person will build up here. Log a note or send a message to start."
        />
      ) : (
        <div className="relative">
          <div className="absolute left-5 top-0 bottom-0 w-px bg-border" />
          <div className="space-y-4">
            {entries.map((entry) =>
              entry.kind === "activity" ? (
                <div key={`a-${entry.id}`} className="flex gap-4">
                  <div className="relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border bg-background shadow-sm">
                    {ACTIVITY_ICONS[entry.activity.type] ?? (
                      <ActivityIcon className="h-4 w-4 text-muted-foreground" />
                    )}
                  </div>
                  <div className="flex-1 pb-2">
                    <div className="flex items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium capitalize">
                          {entry.activity.type.replace(/_/g, " ")}
                        </p>
                        {entry.activity.body && (
                          <p className="text-sm text-muted-foreground mt-0.5 whitespace-pre-line">
                            {entry.activity.body}
                          </p>
                        )}
                        {(() => {
                          const url = entry.activity.metadata?.recordingUrl;
                          // https only — never render javascript:/data: URLs from a webhook.
                          return typeof url === "string" && /^https:\/\//i.test(url) ? (
                            <a href={url} target="_blank" rel="noopener noreferrer" className="text-sm text-blue-600 hover:underline mt-0.5 inline-block">
                              Listen to recording
                            </a>
                          ) : null;
                        })()}
                      </div>
                      <p className="text-xs text-muted-foreground shrink-0 mt-0.5">
                        {formatDistanceToNow(entry.at)} ago
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <div key={`m-${entry.id}`} className="flex gap-4">
                  <div
                    className={cn(
                      "relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border bg-background shadow-sm",
                      entry.message.direction === "inbound"
                        ? "ring-2 ring-blue-200"
                        : "ring-2 ring-green-100",
                    )}
                  >
                    {entry.message.channel === "sms" ? (
                      <MessageSquare className="h-4 w-4 text-blue-600" />
                    ) : (
                      <Mail className="h-4 w-4 text-purple-600" />
                    )}
                  </div>
                  <div className="flex-1 pb-2">
                    <div className="flex items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">
                          {entry.message.direction === "inbound" ? "Received" : "Sent"}{" "}
                          <span className="uppercase text-xs text-muted-foreground tracking-wide ml-1">
                            {entry.message.channel}
                          </span>
                          {entry.message.subject && (
                            <span className="text-muted-foreground ml-2">
                              · {entry.message.subject}
                            </span>
                          )}
                        </p>
                        {entry.message.body && (
                          <p className="text-sm text-muted-foreground mt-0.5 whitespace-pre-line line-clamp-4">
                            {entry.message.body}
                          </p>
                        )}
                        <p className="text-[11px] text-muted-foreground/70 mt-1 capitalize">
                          {entry.message.status}
                        </p>
                      </div>
                      <p className="text-xs text-muted-foreground shrink-0 mt-0.5">
                        {formatDistanceToNow(entry.at)} ago
                      </p>
                    </div>
                  </div>
                </div>
              ),
            )}
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
        <EmptyState
          compact
          icon={DollarSign}
          title="No deals yet"
          description="A deal tracks one sale for this person through your pipeline, from first contact to enrolled."
          action={{ label: "Start a deal", onClick: () => setAddOpen(true) }}
        />
      ) : (
        <div className="space-y-2">
          {deals.map((rowRaw) => {
            const row = rowRaw as Record<string, unknown>;
            const deal = row.deal as Record<string, unknown> | undefined;
            if (!deal) return null;
            const dealStatus = String(deal.status ?? "open");
            return (
              <div key={String(deal.id)} className="flex items-center gap-3 p-4 rounded-xl border border-border bg-card">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-success/10 text-success">
                  <DollarSign className="h-5 w-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm truncate">{String(deal.title)}</p>
                  <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                    <Clock className="h-3 w-3" />Opened {format(new Date(String(deal.createdAt)), "MMM d, yyyy")}
                  </p>
                </div>
                {deal.valueEst != null && (
                  <span className="text-sm font-semibold tabular-nums">${Number(deal.valueEst).toLocaleString()}</span>
                )}
                <StatusPill status={dealStatus} tone={dealStatus === "open" ? "info" : undefined} />
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


  return (
    <div>
      {isLoading ? (
        <div className="space-y-2">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-14 rounded-lg" />)}</div>
      ) : tasks.length === 0 ? (
        <EmptyState
          compact
          icon={CheckSquare}
          title="No tasks for this person"
          description="Follow-ups and reminders linked to this contact will show here."
        />
      ) : (
        <div className="space-y-2">
          {tasks.map((taskRaw) => {
            const t = taskRaw as Record<string, unknown>;
            const status = String(t.status ?? "open");
            return (
              <div key={String(t.id)} className="flex items-center gap-3 p-3 rounded-xl border border-border bg-card">
                <CheckSquare className="h-5 w-5 text-accent shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{String(t.title ?? "")}</p>
                  {t.dueDate != null && <p className="text-xs text-muted-foreground">Due {format(new Date(String(t.dueDate)), "MMM d, yyyy")}</p>}
                </div>
                <StatusPill status={status} tone={status === "open" ? "info" : undefined} />
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


  return (
    <div>
      {isLoading ? (
        <div className="space-y-2">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-14 rounded-lg" />)}</div>
      ) : enrollments.length === 0 ? (
        <EmptyState
          compact
          icon={Workflow}
          title="Not in any sequences"
          description="When this person is added to an automatic follow-up series, you'll see where they are in it here."
        />
      ) : (
        <div className="space-y-2">
          {enrollments.map((rowRaw) => {
            const row = rowRaw as Record<string, unknown>;
            const enroll = row.enrollment as Record<string, unknown> | undefined;
            if (!enroll) return null;
            const status = String(enroll.status ?? "active");
            return (
              <div key={String(enroll.id)} className="flex items-center gap-3 p-3 rounded-xl border border-border bg-card">
                <Workflow className="h-5 w-5 text-accent shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-medium">{String(row.sequenceName ?? "Unknown Sequence")}</p>
                  <p className="text-xs text-muted-foreground">
                    Step {Number(enroll.nextStepIndex ?? 0)} · Enrolled {formatDistanceToNow(new Date(String(enroll.enrolledAt)))} ago
                  </p>
                </div>
                <StatusPill status={status} tone={status === "completed" ? "neutral" : status === "paused" ? "warning" : undefined} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────
// Call Summaries Tab (post-call agent-assist)
// ──────────────────────────────────────────────

// Advisory disposition category styling. These are SUGGESTIONS produced by the
// in-platform transcript parse — the agent confirms before anything is applied.
const DISPOSITION_STYLES: Record<SuggestedDisposition["category"], string> = {
  POSITIVE: "bg-green-100 text-green-800",
  NEUTRAL: "bg-slate-100 text-slate-700",
  NEGATIVE: "bg-red-100 text-red-800",
  COMPLIANCE: "bg-amber-100 text-amber-900",
  FOLLOW_UP: "bg-blue-100 text-blue-800",
  UNKNOWN: "bg-muted text-muted-foreground",
};

const RISK_SEVERITY_STYLES: Record<string, string> = {
  low: "bg-yellow-100 text-yellow-800",
  medium: "bg-orange-100 text-orange-800",
  high: "bg-red-100 text-red-800",
};

function CallSummaryCard({ summary }: { summary: CallSummary }) {
  const disp = summary.suggestedDisposition;
  const confidencePct =
    disp && typeof disp.confidence === "number"
      ? Math.round(disp.confidence * 100)
      : null;

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        {/* Headline: the advisory suggested disposition, clearly labeled. */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Phone className="h-4 w-4 text-blue-500 shrink-0" />
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              Suggested disposition
            </span>
            {disp ? (
              <Badge className={cn("text-xs border-0", DISPOSITION_STYLES[disp.category] ?? "")}>
                {disp.category.replace(/_/g, " ")}
                {confidencePct != null ? ` · ${confidencePct}%` : ""}
              </Badge>
            ) : (
              <Badge className="text-xs border-0 bg-muted text-muted-foreground">
                Not available
              </Badge>
            )}
            {disp?.code && (
              <span className="text-xs text-muted-foreground">({disp.code})</span>
            )}
          </div>
          <p className="text-xs text-muted-foreground shrink-0">
            {summary.parsedAt
              ? `${formatDistanceToNow(new Date(summary.parsedAt))} ago`
              : "—"}
          </p>
        </div>

        {/* Advisory disclaimer — this is a suggestion, not an applied status. */}
        <p className="text-[11px] italic text-muted-foreground">
          Advisory — generated from the call transcript. Review before acting.
        </p>

        {/* Summary text. */}
        {summary.summary && (
          <p className="text-sm whitespace-pre-line">{summary.summary}</p>
        )}

        {/* Risk-flag chips, severity-colored. */}
        {summary.riskFlags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {summary.riskFlags.map((flag, i) => (
              <span
                key={`${flag.kind}-${i}`}
                title={flag.detail}
                className={cn(
                  "inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full",
                  RISK_SEVERITY_STYLES[flag.severity] ?? "bg-muted text-muted-foreground",
                )}
              >
                <AlertTriangle className="h-3 w-3" />
                {flag.kind}
              </span>
            ))}
          </div>
        )}

        {/* Action items. */}
        {summary.actionItems.length > 0 && (
          <div className="space-y-1">
            <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
              <ListChecks className="h-3.5 w-3.5" />
              Action items
            </div>
            <ul className="list-disc list-inside space-y-0.5">
              {summary.actionItems.map((item, i) => (
                <li key={i} className="text-sm text-muted-foreground">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* TODO: wire a "Log as note" / "Apply disposition" action once a
            canonical disposition endpoint exists. Today the contact-status
            model (lead/prospect/…) does not map cleanly to these advisory
            categories, and there is no disposition write API — so this panel
            is intentionally read-only rather than inventing a mapping. */}
      </CardContent>
    </Card>
  );
}

function CallSummariesTab({ contactId }: { contactId: string }) {
  const { data, isLoading } = useContactCallSummaries(contactId);
  const summaries: CallSummary[] = data?.data ?? [];

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[...Array(2)].map((_, i) => (
          <Skeleton key={i} className="h-40 rounded-xl" />
        ))}
      </div>
    );
  }

  if (summaries.length === 0) {
    return (
      <EmptyState
        compact
        icon={Phone}
        title="No call summaries yet"
        description="After a call through the dialer, a short summary of what was discussed appears here."
      />
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground text-right">
        {summaries.length} call{summaries.length !== 1 ? "s" : ""} summarized
      </p>
      {summaries.map((s) => (
        <CallSummaryCard key={s.ticketId} summary={s} />
      ))}
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
  const [leadOpen, setLeadOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState<UpdateContactBody>({});

  const { data: contactRaw, isLoading } = useGetContact(id);
  const { mutateAsync: updateContact, isPending: isSaving } = useUpdateContact();

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
      dob: c.dob?.slice(0, 10) ?? null,
      preferredLanguage: c.preferredLanguage,
      pcpName: c.pcpName,
      pcpNpi: c.pcpNpi,
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
    if (isSaving) return;
    if (!editForm.firstName?.trim() || !editForm.lastName?.trim()) {
      toast.error("First and last name are required");
      return;
    }
    try {
      // Submit only changes, so role-masked identifiers are never written back.
      const data = Object.fromEntries(
        Object.entries(editForm).filter(([key, value]) =>
          value !== c[key as keyof Contact],
        ),
      ) as UpdateContactBody;
      if (Object.keys(data).length > 0) await updateContact({ id, data });
      toast.success("Contact updated");
      setEditOpen(false);
      void qc.invalidateQueries({ queryKey: getGetContactQueryKey(id) });
    } catch (error) { toast.error(error instanceof Error ? error.message : "Failed to update contact"); }
  };

  const detailGroups: Array<{ title: string; rows: Array<[string, string | number | null | undefined]> }> = [
    {
      title: "Contact",
      rows: [
        ["First name", c.firstName],
        ["Last name", c.lastName],
        ["Email", c.email],
        ["Phone", c.phone ? formatPhone(c.phone) : c.phone],
        ["Preferred language", c.preferredLanguage],
        ["SMS preference", c.optOutSms ? "Opted out" : "Not opted out"],
        ["Email preference", c.optOutEmail ? "Opted out" : "Not opted out"],
      ],
    },
    {
      title: "Medicare & plan",
      rows: [
        ["Date of birth", c.dob?.slice(0, 10)],
        ["Medicare ID", c.medicareId],
        ["Plan type", c.currentPlanType ? PLAN_TYPE_LABELS[c.currentPlanType] ?? c.currentPlanType : null],
        ["Plan year", c.planYear],
        ["Primary care provider", c.pcpName],
        ["Provider NPI", c.pcpNpi],
        ["Health conditions", c.healthConditions?.join(", ")],
      ],
    },
    {
      title: "Location & source",
      rows: [
        ["County", c.county],
        ["State", c.stateCode],
        ["ZIP code", c.zipCode],
        ["Lead source", c.leadSource],
        ["Tags", c.tags?.join(", ")],
      ],
    },
  ];

  const chips: Array<{ icon: typeof Heart; text: string }> = [
    ...(c.currentPlanType ? [{ icon: Heart, text: `${PLAN_TYPE_LABELS[c.currentPlanType] ?? c.currentPlanType}${c.planYear ? ` · ${c.planYear}` : ""}` }] : []),
    ...((c.county || c.stateCode) ? [{ icon: MapPin, text: [c.county, c.stateCode].filter(Boolean).join(", ") }] : []),
    ...(c.leadSource ? [{ icon: User, text: `Source: ${c.leadSource}` }] : []),
    ...(c.dob ? [{ icon: Calendar, text: `Born ${format(new Date(c.dob), "MMM d, yyyy")}` }] : []),
  ];

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" onClick={() => nav("/crm")}>
        <ArrowLeft className="h-4 w-4 mr-1" />Back to Clients &amp; Leads
      </Button>

      {/* Contact header */}
      <section className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
        <div className="p-5 sm:p-6">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-start">
            <div className="flex min-w-0 flex-1 items-start gap-4">
              <ContactAvatar first={c.firstName} last={c.lastName} size="xl" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2.5">
                  <h1 className="font-display text-2xl font-bold tracking-tight">{contactName}</h1>
                  <StatusPill status={c.status} />
                  {c.optOutSms && <StatusPill tone="danger">No texts (opted out)</StatusPill>}
                  {c.optOutEmail && <StatusPill tone="danger">No emails (opted out)</StatusPill>}
                </div>
                {/* Email and phone on their own line, each kept whole. */}
                <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                  {c.email && (
                    <a href={`mailto:${c.email}`} className="inline-flex min-w-0 max-w-full items-center gap-1.5 hover:text-foreground">
                      <Mail className="h-4 w-4 shrink-0" /><span className="truncate" title={c.email}>{c.email}</span>
                    </a>
                  )}
                  {c.phone && (
                    <a href={`tel:${c.phone}`} className="inline-flex items-center gap-1.5 whitespace-nowrap hover:text-foreground">
                      <Phone className="h-4 w-4 shrink-0" />{formatPhone(c.phone)}
                    </a>
                  )}
                  {c.medicareId && (
                    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                      <Shield className="h-4 w-4 shrink-0" />Medicare ID {c.medicareId}
                    </span>
                  )}
                </div>
                {chips.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {chips.map(({ icon: Icon, text }) => (
                      <span key={text} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs text-foreground whitespace-nowrap">
                        <Icon className="h-3.5 w-3.5 text-muted-foreground" />{text}
                      </span>
                    ))}
                    {(c.tags ?? []).map((tag) => (
                      <span key={`tag-${tag}`} className="inline-flex items-center rounded-full bg-accent/10 px-2.5 py-1 text-xs text-accent whitespace-nowrap">{tag}</span>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="flex flex-wrap gap-2 xl:flex-nowrap xl:justify-end">
              {c.phone && !c.optOutSms && <Button size="sm" onClick={() => setSmsOpen(true)}><MessageSquare className="h-4 w-4 mr-1.5" />SMS</Button>}
              {c.email && !c.optOutEmail && <Button size="sm" variant="outline" onClick={() => setEmailOpen(true)}><Mail className="h-4 w-4 mr-1.5" />Email</Button>}
              <Button size="sm" variant="outline" onClick={() => setLogOpen(true)}><ActivityIcon className="h-4 w-4 mr-1.5" />Log</Button>
              <BookAppointmentButton contactId={id} contactName={contactName} />
              <Button size="sm" variant="outline" onClick={() => setLeadOpen(true)}><Plus className="h-4 w-4 mr-1.5" />Create Lead</Button>
              <Button size="sm" variant="outline" onClick={openEdit}><Edit className="h-4 w-4 mr-1.5" />Edit</Button>
            </div>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        {/* Activity & records */}
        <div className="min-w-0 xl:col-span-2">
          <Tabs defaultValue="timeline" className="space-y-4">
            <TabsList className="flex-wrap h-auto gap-1 bg-card border border-border shadow-sm p-1 rounded-xl">
              <TabsTrigger value="timeline" className="gap-1.5"><ActivityIcon className="h-4 w-4" />Timeline</TabsTrigger>
              <TabsTrigger value="call-summaries" className="gap-1.5"><Phone className="h-4 w-4" />Call summaries</TabsTrigger>
              <TabsTrigger value="deals" className="gap-1.5"><DollarSign className="h-4 w-4" />Deals</TabsTrigger>
              <TabsTrigger value="tasks" className="gap-1.5"><CheckSquare className="h-4 w-4" />Tasks</TabsTrigger>
              <TabsTrigger value="sequences" className="gap-1.5"><Workflow className="h-4 w-4" />Sequences</TabsTrigger>
              <TabsTrigger value="applications" className="gap-1.5"><FileText className="h-4 w-4" />Applications</TabsTrigger>
            </TabsList>
            <TabsContent value="timeline"><SectionCard><TimelineTab contactId={id} /></SectionCard></TabsContent>
            <TabsContent value="call-summaries"><SectionCard><CallSummariesTab contactId={id} /></SectionCard></TabsContent>
            <TabsContent value="deals"><SectionCard><DealsTab contactId={id} /></SectionCard></TabsContent>
            <TabsContent value="tasks"><SectionCard><TasksTab contactId={id} /></SectionCard></TabsContent>
            <TabsContent value="sequences"><SectionCard><SequencesTab contactId={id} /></SectionCard></TabsContent>
            <TabsContent value="applications"><SectionCard><ApplicationsTab contactId={id} /></SectionCard></TabsContent>
          </Tabs>
        </div>

        {/* Contact details — label above value so long emails and
            addresses wrap cleanly instead of breaking mid-word. */}
        <SectionCard title="Contact details" className="self-start" actions={
          <Button size="sm" variant="ghost" className="h-8" onClick={openEdit} aria-label="Edit contact details"><Edit className="h-4 w-4" /></Button>
        }>
          <div className="space-y-5">
            {detailGroups.map((group) => (
              <div key={group.title}>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">{group.title}</p>
                <dl className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-1 gap-x-6 gap-y-3">
                  {group.rows.map(([label, value]) => {
                    const empty = value === null || value === undefined || value === "";
                    return (
                      <div key={label} className="min-w-0">
                        <dt className="text-xs text-muted-foreground">{label}</dt>
                        <dd className={cn("mt-0.5 text-sm [overflow-wrap:anywhere] whitespace-pre-wrap", empty && "text-muted-foreground/70")}>
                          {empty ? "Not provided" : value}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>

      {/* Modals */}
      <SendSmsModal contactId={id} contactName={contactName} open={smsOpen} onClose={() => setSmsOpen(false)} />
      <CreateLeadDialog contactId={id} contactName={contactName} open={leadOpen} onOpenChange={setLeadOpen} />
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
              { key: "email", label: "Email", type: "email" },
              { key: "dob", label: "Date of Birth", type: "date" },
              { key: "preferredLanguage", label: "Preferred Language" },
              { key: "pcpName", label: "Primary Care Provider" },
              { key: "pcpNpi", label: "Provider NPI" },
              { key: "phone", label: "Phone" },
              { key: "medicareId", label: "Medicare ID" },
              { key: "planYear", label: "Plan Year", type: "number" },
              { key: "stateCode", label: "State", maxLength: 2 },
              { key: "zipCode", label: "ZIP Code" },
              { key: "county", label: "County" },
              { key: "leadSource", label: "Lead Source" },
            ] as Array<{ key: keyof UpdateContactBody; label: string; type?: string; maxLength?: number }>).map(({ key, label, type, maxLength }) => (
              <div key={key} className="space-y-1.5">
                <Label htmlFor={`contact-edit-${key}`}>{label}</Label>
                <Input
                  id={`contact-edit-${key}`}
                  type={type ?? "text"}
                  maxLength={maxLength}
                  value={String(editForm[key] ?? "")}
                  onChange={(e) => {
                    const value = e.target.value;
                    setEditForm((f) => ({
                      ...f,
                      [key]: key === "planYear"
                        ? (value === "" ? null : Number(value))
                        : key === "firstName" || key === "lastName"
                          ? value
                          : value || null,
                    }));
                  }}
                />
              </div>
            ))}
            <div className="space-y-1.5">
              <Label>Plan Type</Label>
              <Select value={String(editForm.currentPlanType ?? "__none__")} onValueChange={(v) => setEditForm((f) => ({ ...f, currentPlanType: v === "__none__" ? null : v }))}>
                <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">None</SelectItem>
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
            <Button onClick={saveEdit} disabled={isSaving}>{isSaving ? "Saving…" : "Save Changes"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
