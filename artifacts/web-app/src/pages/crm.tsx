import { useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import type {
  Contact, LeadListResponseDataItem, PipelineWithStages, PipelineStage,
  GetDeals200Item, ThreadWithContact, SequenceWithStats, Sequence,
  LeadStats, RetentionSummary, InboxResponseDataItem,
  CreateContactBody, CreateLeadBody, CreateDealBody, CreatePipelineBody,
  CreateSequenceBody, BulkContactActionBody, UpdateLeadBody, UpdateDealBody,
  UpdateSequenceBody,
} from "@workspace/api-client-react";
import {
  useGetContacts, useCreateContact, useBulkContactAction,
  useGetLeads, useCreateLead, useUpdateLead, useConvertLead, useGetLeadStats,
  useGetPipelines, useCreatePipeline, useGetDeals, useCreateDeal, useUpdateDeal,
  useGetPipelineAnalytics,
  useGetThreads, useGetInbox, useReplyInThread, useMarkMessageRead,
  useGetSequences, useCreateSequence, useUpdateSequence,
  useGetRetentionBirthdays, useGetRetentionAtRisk, useGetRetentionAep, useGetRetentionSummary,
  getGetContactsQueryKey, getGetLeadsQueryKey, getGetPipelinesQueryKey,
  getGetDealsQueryKey, getGetSequencesQueryKey, getGetInboxQueryKey, getGetThreadsQueryKey,
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
import { Checkbox } from "@/components/ui/checkbox";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Users, Plus, Search, Mail, MessageSquare, Inbox,
  Workflow, Shield, ChevronRight,
  AlertTriangle, Calendar, Target, TrendingUp, Send, CheckCircle2,
  DollarSign, ArrowRight, Clock, Cake, Star, MoreHorizontal,
} from "lucide-react";
import { toast } from "sonner";
import { format, formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";

// ──────────────────────────────────────────────
// Style maps & helpers
// ──────────────────────────────────────────────

const CONTACT_STATUS_STYLES: Record<string, string> = {
  lead: "bg-blue-100 text-blue-800",
  prospect: "bg-purple-100 text-purple-800",
  enrolled: "bg-green-100 text-green-800",
  retained: "bg-emerald-100 text-emerald-800",
  lost: "bg-red-100 text-red-800",
  do_not_contact: "bg-slate-100 text-slate-600",
};

const LEAD_STATUS_STYLES: Record<string, string> = {
  new: "bg-blue-100 text-blue-800",
  contacted: "bg-amber-100 text-amber-800",
  qualified: "bg-purple-100 text-purple-800",
  disqualified: "bg-red-100 text-red-800",
  converted: "bg-green-100 text-green-800",
};

const PLAN_TYPE_LABELS: Record<string, string> = {
  MA: "Medicare Advantage", PDP: "Part D", MAPD: "MAPD", supp: "Supplement", other: "Other",
};

const SEQ_STATUS_STYLES: Record<string, string> = {
  active: "bg-green-100 text-green-800",
  paused: "bg-amber-100 text-amber-800",
  draft: "bg-slate-100 text-slate-600",
};

function initials(first: string, last: string) {
  return `${first?.[0] ?? ""}${last?.[0] ?? ""}`.toUpperCase();
}

// ──────────────────────────────────────────────
// Contacts Tab
// ──────────────────────────────────────────────

function ContactsTab() {
  const [, nav] = useLocation();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkAction, setBulkAction] = useState("assign_agent");
  const [bulkPayload, setBulkPayload] = useState("");
  const [form, setForm] = useState<CreateContactBody>({
    firstName: "", lastName: "", email: null, phone: null,
    status: "lead", leadSource: null, stateCode: null, zipCode: null,
    medicareId: null, currentPlanType: null,
  });

  const { data, isLoading } = useGetContacts({
    search: search || undefined,
    status: statusFilter === "all" ? undefined : statusFilter,
    limit: 100,
  });
  const { mutateAsync: createContact, isPending } = useCreateContact();
  const { mutateAsync: bulkMutate } = useBulkContactAction();

  const contacts: Contact[] = data?.data ?? [];

  const handleCreate = async () => {
    if (!form.firstName || !form.lastName) { toast.error("First and last name required"); return; }
    try {
      await createContact({ data: form });
      toast.success("Contact created");
      setAddOpen(false);
      setForm({ firstName: "", lastName: "", email: null, phone: null, status: "lead", leadSource: null, stateCode: null, zipCode: null, medicareId: null, currentPlanType: null });
      void qc.invalidateQueries({ queryKey: getGetContactsQueryKey() });
    } catch { toast.error("Failed to create contact"); }
  };

  const handleBulk = async () => {
    if (selected.length === 0) { toast.error("No contacts selected"); return; }
    try {
      // CSV export returns a binary/text response — must be handled as a direct fetch + file download,
      // NOT via the JSON-parsing React Query mutation hook.
      if (bulkAction === "export_csv") {
        const resp = await fetch(`${import.meta.env.BASE_URL}api/contacts/bulk`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: selected, action: "export_csv" }),
        });
        if (!resp.ok) { toast.error("Export failed"); return; }
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `contacts-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        toast.success(`Exported ${selected.length} contacts as CSV`);
        setBulkOpen(false);
        setSelected([]);
        return;
      }

      const payload: BulkContactActionBody["payload"] = {};
      if (bulkAction === "assign_agent") payload!.agentId = bulkPayload;
      if (bulkAction === "add_tag" || bulkAction === "remove_tag") payload!.tag = bulkPayload;
      if (bulkAction === "set_status") payload!.status = bulkPayload;
      await bulkMutate({ data: { ids: selected, action: bulkAction as BulkContactActionBody["action"], payload } });
      toast.success(`Bulk action applied to ${selected.length} contacts`);
      setBulkOpen(false);
      setSelected([]);
      void qc.invalidateQueries({ queryKey: getGetContactsQueryKey() });
    } catch { toast.error("Bulk action failed"); }
  };

  const toggleSelect = (id: string) => setSelected((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);
  const toggleAll = () => setSelected(selected.length === contacts.length ? [] : contacts.map((c) => c.id));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search name, phone, email, Medicare ID…" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="lead">Lead</SelectItem>
            <SelectItem value="prospect">Prospect</SelectItem>
            <SelectItem value="enrolled">Enrolled</SelectItem>
            <SelectItem value="retained">Retained</SelectItem>
            <SelectItem value="lost">Lost</SelectItem>
          </SelectContent>
        </Select>
        {selected.length > 0 && (
          <Button variant="outline" size="sm" onClick={() => setBulkOpen(true)}>
            <MoreHorizontal className="h-4 w-4 mr-1" />Bulk ({selected.length})
          </Button>
        )}
        <Button size="sm" onClick={() => setAddOpen(true)}><Plus className="h-4 w-4 mr-1" />New Contact</Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12 w-full rounded-lg" />)}</div>
      ) : contacts.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Users className="h-12 w-12 text-muted-foreground/20 mb-3" />
          <p className="font-medium text-muted-foreground">No contacts found</p>
          <p className="text-sm text-muted-foreground/70 mt-1">Add your first contact to get started</p>
        </div>
      ) : (
        <div className="rounded-xl border bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/30 border-b">
              <tr>
                <th className="w-10 px-4 py-3 text-left">
                  <Checkbox checked={selected.length === contacts.length && contacts.length > 0} onCheckedChange={toggleAll} />
                </th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Name</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground hidden md:table-cell">Contact</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground hidden lg:table-cell">Plan</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground hidden xl:table-cell">Source</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground hidden xl:table-cell">Added</th>
                <th className="w-8 px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {contacts.map((c) => (
                <tr key={c.id} className="hover:bg-muted/20 transition-colors cursor-pointer" onClick={() => nav(`/crm/contacts/${c.id}`)}>
                  <td className="px-4 py-3" onClick={(e) => { e.stopPropagation(); toggleSelect(c.id); }}>
                    <Checkbox checked={selected.includes(c.id)} onCheckedChange={() => toggleSelect(c.id)} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Avatar className="h-8 w-8 shrink-0">
                        <AvatarFallback className="text-xs bg-primary/10 text-primary">{initials(c.firstName, c.lastName)}</AvatarFallback>
                      </Avatar>
                      <div>
                        <p className="font-medium leading-tight">{c.firstName} {c.lastName}</p>
                        {c.medicareId && <p className="text-xs text-muted-foreground">ID: {c.medicareId}</p>}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    <div className="text-xs text-muted-foreground space-y-0.5">
                      {c.phone && <div className="flex items-center gap-1">📞 {c.phone}</div>}
                      {c.email && <div className="flex items-center gap-1 max-w-[160px] truncate"><Mail className="h-3 w-3 shrink-0" />{c.email}</div>}
                    </div>
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell">
                    {c.currentPlanType ? (
                      <div className="text-xs">
                        <span className="font-medium">{PLAN_TYPE_LABELS[c.currentPlanType] ?? c.currentPlanType}</span>
                        {c.planYear && <span className="text-muted-foreground ml-1">({c.planYear})</span>}
                      </div>
                    ) : <span className="text-xs text-muted-foreground">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    <Badge className={cn("text-xs border-0", CONTACT_STATUS_STYLES[c.status] ?? "")}>{c.status.replace(/_/g, " ")}</Badge>
                  </td>
                  <td className="px-4 py-3 hidden xl:table-cell text-xs text-muted-foreground">{c.leadSource ?? "—"}</td>
                  <td className="px-4 py-3 hidden xl:table-cell text-xs text-muted-foreground">{format(new Date(c.createdAt), "MMM d, yyyy")}</td>
                  <td className="px-4 py-3"><ChevronRight className="h-4 w-4 text-muted-foreground" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add Contact Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>New Contact</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-3 py-2">
            <div className="space-y-1.5">
              <Label>First Name *</Label>
              <Input value={form.firstName} onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Last Name *</Label>
              <Input value={form.lastName} onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input type="email" value={form.email ?? ""} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value || null }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Phone</Label>
              <Input value={form.phone ?? ""} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value || null }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Medicare ID</Label>
              <Input value={form.medicareId ?? ""} onChange={(e) => setForm((f) => ({ ...f, medicareId: e.target.value || null }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Plan Type</Label>
              <Select value={form.currentPlanType ?? ""} onValueChange={(v) => setForm((f) => ({ ...f, currentPlanType: v || null }))}>
                <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                <SelectContent>
                  {Object.entries(PLAN_TYPE_LABELS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>State</Label>
              <Input maxLength={2} placeholder="e.g. TX" value={form.stateCode ?? ""} onChange={(e) => setForm((f) => ({ ...f, stateCode: e.target.value.toUpperCase() || null }))} />
            </div>
            <div className="space-y-1.5">
              <Label>ZIP Code</Label>
              <Input value={form.zipCode ?? ""} onChange={(e) => setForm((f) => ({ ...f, zipCode: e.target.value || null }))} />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label>Status</Label>
              <Select value={form.status ?? "lead"} onValueChange={(v) => setForm((f) => ({ ...f, status: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="lead">Lead</SelectItem>
                  <SelectItem value="prospect">Prospect</SelectItem>
                  <SelectItem value="enrolled">Enrolled</SelectItem>
                  <SelectItem value="retained">Retained</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label>Lead Source</Label>
              <Input placeholder="e.g. Web form, Referral, Direct mail…" value={form.leadSource ?? ""} onChange={(e) => setForm((f) => ({ ...f, leadSource: e.target.value || null }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={isPending}>{isPending ? "Creating…" : "Create Contact"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Action Dialog */}
      <Dialog open={bulkOpen} onOpenChange={setBulkOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Bulk Action — {selected.length} contacts</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label>Action</Label>
              <Select value={bulkAction} onValueChange={setBulkAction}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="assign_agent">Assign Agent</SelectItem>
                  <SelectItem value="add_tag">Add Tag</SelectItem>
                  <SelectItem value="remove_tag">Remove Tag</SelectItem>
                  <SelectItem value="set_status">Set Status</SelectItem>
                  <SelectItem value="export_csv">Export CSV</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {bulkAction !== "export_csv" && (
              <div className="space-y-1.5">
                <Label>{bulkAction === "assign_agent" ? "Agent ID" : bulkAction === "set_status" ? "Status" : "Tag"}</Label>
                {bulkAction === "set_status" ? (
                  <Select value={bulkPayload} onValueChange={setBulkPayload}>
                    <SelectTrigger><SelectValue placeholder="Select status…" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="lead">Lead</SelectItem>
                      <SelectItem value="prospect">Prospect</SelectItem>
                      <SelectItem value="enrolled">Enrolled</SelectItem>
                      <SelectItem value="lost">Lost</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <Input value={bulkPayload} onChange={(e) => setBulkPayload(e.target.value)} />
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkOpen(false)}>Cancel</Button>
            <Button onClick={handleBulk}>Apply</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ──────────────────────────────────────────────
// Leads Tab
// ──────────────────────────────────────────────

function LeadsTab() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("all");
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState<CreateLeadBody>({ contactId: "", source: null, sourceDetail: null, score: 0, status: "new" });

  const { data, isLoading } = useGetLeads({ status: statusFilter === "all" ? undefined : statusFilter, limit: 100 });
  const { data: stats } = useGetLeadStats();
  const { mutateAsync: createLead, isPending } = useCreateLead();
  const { mutateAsync: convertLead } = useConvertLead();
  const { mutateAsync: updateLead } = useUpdateLead();

  const leads: LeadListResponseDataItem[] = data?.data ?? [];
  const leadStats = stats as LeadStats | undefined;

  const handleCreate = async () => {
    if (!form.contactId) { toast.error("Contact ID required"); return; }
    try {
      await createLead({ data: form });
      toast.success("Lead created");
      setAddOpen(false);
      void qc.invalidateQueries({ queryKey: getGetLeadsQueryKey() });
    } catch { toast.error("Failed to create lead"); }
  };

  const handleConvert = async (id: string) => {
    try {
      await convertLead({ id });
      toast.success("Lead converted to prospect");
      void qc.invalidateQueries({ queryKey: getGetLeadsQueryKey() });
    } catch { toast.error("Conversion failed"); }
  };

  const handleUpdateStatus = async (id: string, status: string) => {
    await updateLead({ id, data: { status } satisfies UpdateLeadBody });
    void qc.invalidateQueries({ queryKey: getGetLeadsQueryKey() });
  };

  return (
    <div className="space-y-4">
      {leadStats && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {(leadStats.byStatus ?? []).map((s) => {
            const item = s as Record<string, unknown>;
            return (
              <Card key={String(item.status)} className="py-3">
                <CardContent className="px-4 py-0 text-center">
                  <p className="text-xl font-bold">{String(item.count)}</p>
                  <p className="text-xs text-muted-foreground capitalize mt-0.5">{String(item.status)}</p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <div className="flex items-center gap-3">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="new">New</SelectItem>
            <SelectItem value="contacted">Contacted</SelectItem>
            <SelectItem value="qualified">Qualified</SelectItem>
            <SelectItem value="disqualified">Disqualified</SelectItem>
            <SelectItem value="converted">Converted</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex-1" />
        <Button size="sm" onClick={() => setAddOpen(true)}><Plus className="h-4 w-4 mr-1" />New Lead</Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-14 w-full rounded-lg" />)}</div>
      ) : leads.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Target className="h-12 w-12 text-muted-foreground/20 mb-3" />
          <p className="font-medium text-muted-foreground">No leads found</p>
        </div>
      ) : (
        <div className="space-y-2">
          {leads.map((rowRaw) => {
            const row = rowRaw as Record<string, unknown>;
            const lead = row.lead as Record<string, unknown> | undefined;
            const contact = row.contact as Record<string, unknown> | undefined;
            if (!lead) return null;
            const leadId = String(lead.id);
            const leadStatus = String(lead.status ?? "new");
            return (
              <div key={leadId} className="flex items-center gap-4 p-4 rounded-xl border bg-card hover:bg-muted/20 transition-colors">
                <Avatar className="h-10 w-10 shrink-0">
                  <AvatarFallback className="text-sm bg-primary/10 text-primary">
                    {initials(String(contact?.firstName ?? ""), String(contact?.lastName ?? ""))}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-medium">{String(contact?.firstName ?? "")} {String(contact?.lastName ?? "")}</p>
                    <Badge className={cn("text-xs border-0", LEAD_STATUS_STYLES[leadStatus] ?? "")}>{leadStatus}</Badge>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                    {lead.source != null && <span>{String(lead.source)}</span>}
                    <span className="flex items-center gap-1"><Star className="h-3 w-3" />Score: {String(lead.score ?? 0)}</span>
                    {lead.createdAt != null && <span>{format(new Date(String(lead.createdAt)), "MMM d, yyyy")}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {leadStatus !== "converted" && leadStatus !== "disqualified" && (
                    <>
                      <Select value={leadStatus} onValueChange={(v) => handleUpdateStatus(leadId, v)}>
                        <SelectTrigger className="h-7 w-32 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="new">New</SelectItem>
                          <SelectItem value="contacted">Contacted</SelectItem>
                          <SelectItem value="qualified">Qualified</SelectItem>
                          <SelectItem value="disqualified">Disqualified</SelectItem>
                        </SelectContent>
                      </Select>
                      {leadStatus === "qualified" && (
                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => handleConvert(leadId)}>
                          <ArrowRight className="h-3 w-3 mr-1" />Convert
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>New Lead</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label>Contact ID *</Label>
              <Input placeholder="Paste contact ID…" value={form.contactId} onChange={(e) => setForm((f) => ({ ...f, contactId: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Source</Label>
                <Input placeholder="e.g. Web form" value={form.source ?? ""} onChange={(e) => setForm((f) => ({ ...f, source: e.target.value || null }))} />
              </div>
              <div className="space-y-1.5">
                <Label>Score (0–100)</Label>
                <Input type="number" min="0" max="100" value={form.score ?? 0} onChange={(e) => setForm((f) => ({ ...f, score: parseInt(e.target.value) || 0 }))} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select value={form.status ?? "new"} onValueChange={(v) => setForm((f) => ({ ...f, status: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="new">New</SelectItem>
                  <SelectItem value="contacted">Contacted</SelectItem>
                  <SelectItem value="qualified">Qualified</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={isPending}>{isPending ? "Creating…" : "Create Lead"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ──────────────────────────────────────────────
// Pipeline Tab
// ──────────────────────────────────────────────

function PipelineTab() {
  const qc = useQueryClient();
  const [selectedPipelineId, setSelectedPipelineId] = useState<string | null>(null);
  const [addDealOpen, setAddDealOpen] = useState(false);
  const [addPipelineOpen, setAddPipelineOpen] = useState(false);
  const [dealForm, setDealForm] = useState<CreateDealBody>({ pipelineId: "", stageId: "", contactId: "", title: "", valueEst: null });
  const [pipelineForm, setPipelineForm] = useState<Pick<CreatePipelineBody, "name" | "description">>({ name: "", description: "" });

  const { data: pipelines, isLoading: pipelinesLoading } = useGetPipelines();
  const pipelineList: PipelineWithStages[] = pipelines ?? [];
  const activePipeline: PipelineWithStages | undefined = selectedPipelineId
    ? pipelineList.find((p) => p.id === selectedPipelineId)
    : pipelineList[0];

  const { data: dealsRaw, isLoading: dealsLoading } = useGetDeals({
    pipelineId: activePipeline?.id,
    limit: 500,
  });
  const { data: analytics } = useGetPipelineAnalytics(activePipeline?.id ?? "", {
    query: { enabled: !!activePipeline?.id, queryKey: ["pipeline-analytics", activePipeline?.id ?? ""] },
  });

  const { mutateAsync: createDeal } = useCreateDeal();
  const { mutateAsync: updateDeal } = useUpdateDeal();
  const { mutateAsync: createPipeline, isPending: creatingPipeline } = useCreatePipeline();

  const stages: PipelineStage[] = activePipeline?.stages ?? [];
  const deals: GetDeals200Item[] = dealsRaw ?? [];

  const handleCreateDeal = async () => {
    if (!dealForm.contactId || !dealForm.title || !dealForm.stageId || !dealForm.pipelineId) {
      toast.error("Pipeline, contact, title, and stage are required"); return;
    }
    try {
      await createDeal({ data: dealForm });
      toast.success("Deal created");
      setAddDealOpen(false);
      void qc.invalidateQueries({ queryKey: getGetDealsQueryKey() });
    } catch { toast.error("Failed to create deal"); }
  };

  const handleCreatePipeline = async () => {
    if (!pipelineForm.name) { toast.error("Pipeline name required"); return; }
    try {
      const p = await createPipeline({
        data: {
          ...pipelineForm,
          stages: [
            { name: "New Lead", color: "#6366f1", probabilityPct: 10 },
            { name: "Contacted", color: "#f59e0b", probabilityPct: 30 },
            { name: "Qualified", color: "#8b5cf6", probabilityPct: 50 },
            { name: "Application", color: "#ec4899", probabilityPct: 70 },
            { name: "Enrolled", color: "#10b981", probabilityPct: 90 },
          ],
        },
      });
      toast.success("Pipeline created");
      setAddPipelineOpen(false);
      setPipelineForm({ name: "", description: "" });
      setSelectedPipelineId((p as { id: string }).id);
      void qc.invalidateQueries({ queryKey: getGetPipelinesQueryKey() });
    } catch { toast.error("Failed to create pipeline"); }
  };

  const moveStage = async (dealId: string, stageId: string) => {
    await updateDeal({ id: dealId, data: { stageId } satisfies UpdateDealBody });
    void qc.invalidateQueries({ queryKey: getGetDealsQueryKey() });
  };

  if (pipelinesLoading) return <div className="space-y-2">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-40 rounded-xl" />)}</div>;

  if (pipelineList.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <TrendingUp className="h-12 w-12 text-muted-foreground/20 mb-3" />
        <p className="font-medium text-muted-foreground">No pipelines yet</p>
        <p className="text-sm text-muted-foreground/70 mt-1 mb-4">Create your first sales pipeline to track deals</p>
        <Button size="sm" onClick={() => setAddPipelineOpen(true)}><Plus className="h-4 w-4 mr-1" />Create Pipeline</Button>
        <CreatePipelineDialog open={addPipelineOpen} onOpenChange={setAddPipelineOpen} form={pipelineForm} setForm={setPipelineForm} onSubmit={handleCreatePipeline} isPending={creatingPipeline} />
      </div>
    );
  }

  const pipelineAnalytics = analytics as
    | {
        totalDeals?: number;
        wonDeals?: number;
        lostDeals?: number;
        openDeals?: number;
        conversionRate?: number;
        openValueTotal?: number;
        wonValueTotal?: number;
        lostValueTotal?: number;
      }
    | undefined;

  const fmtCurrency = (n: number) => `$${Math.round(n).toLocaleString()}`;

  const closeDeal = async (
    dealId: string,
    status: "won" | "lost",
    lostReason?: string,
  ) => {
    try {
      await updateDeal({
        id: dealId,
        data: { status, ...(status === "lost" ? { lostReason: lostReason ?? null } : {}) } satisfies UpdateDealBody,
      });
      toast.success(status === "won" ? "Deal marked as won" : "Deal marked as lost");
      void qc.invalidateQueries({ queryKey: getGetDealsQueryKey() });
      void qc.invalidateQueries({ queryKey: ["pipeline-analytics", activePipeline?.id ?? ""] });
    } catch {
      toast.error(`Failed to mark deal as ${status}`);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={activePipeline?.id ?? ""} onValueChange={setSelectedPipelineId}>
          <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            {pipelineList.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={() => setAddPipelineOpen(true)}><Plus className="h-4 w-4 mr-1" />New Pipeline</Button>
        <div className="flex-1" />
        <Button size="sm" onClick={() => {
          setDealForm((f) => ({ ...f, pipelineId: activePipeline?.id ?? "" }));
          setAddDealOpen(true);
        }}><Plus className="h-4 w-4 mr-1" />New Deal</Button>
      </div>

      {pipelineAnalytics && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Card className="py-3"><CardContent className="px-4 py-0 text-center">
            <p className="text-xl font-bold">{pipelineAnalytics.totalDeals ?? 0}</p>
            <p className="text-xs text-muted-foreground">Total Deals</p>
          </CardContent></Card>
          <Card className="py-3"><CardContent className="px-4 py-0 text-center">
            <p className="text-xl font-bold tabular-nums">{fmtCurrency(pipelineAnalytics.openValueTotal ?? 0)}</p>
            <p className="text-xs text-muted-foreground">Open Pipeline</p>
          </CardContent></Card>
          <Card className="py-3"><CardContent className="px-4 py-0 text-center">
            <p className="text-xl font-bold text-green-700 tabular-nums">{fmtCurrency(pipelineAnalytics.wonValueTotal ?? 0)}</p>
            <p className="text-xs text-muted-foreground">Won ({pipelineAnalytics.wonDeals ?? 0})</p>
          </CardContent></Card>
          <Card className="py-3"><CardContent className="px-4 py-0 text-center">
            <p className="text-xl font-bold text-red-700 tabular-nums">{fmtCurrency(pipelineAnalytics.lostValueTotal ?? 0)}</p>
            <p className="text-xs text-muted-foreground">Lost ({pipelineAnalytics.lostDeals ?? 0})</p>
          </CardContent></Card>
          <Card className="py-3"><CardContent className="px-4 py-0 text-center">
            <p className="text-xl font-bold">{pipelineAnalytics.conversionRate ?? 0}%</p>
            <p className="text-xs text-muted-foreground">Conv. Rate</p>
          </CardContent></Card>
        </div>
      )}

      {dealsLoading ? <Skeleton className="h-64 w-full rounded-xl" /> : (
        <ScrollArea className="w-full">
          <div className="flex gap-4 pb-4 min-w-max">
            {stages.map((stage) => {
              const stageDeals = deals.filter((rowRaw) => {
                const row = rowRaw as Record<string, unknown>;
                const deal = row.deal as Record<string, unknown> | undefined;
                // Only count open deals in stage columns — won/lost get their
                // own pipeline-level totals shown in the stat cards above.
                return deal?.stageId === stage.id && deal?.status === "open";
              });
              // Real-time per-stage value rolls up from the deals list, so the
              // total updates immediately on stage moves / won/lost without
              // waiting for the analytics refetch.
              const stageValueTotal = stageDeals.reduce((sum, rowRaw) => {
                const deal = (rowRaw as Record<string, unknown>).deal as
                  | Record<string, unknown>
                  | undefined;
                return sum + (Number(deal?.valueEst ?? 0) || 0);
              }, 0);
              return (
                <div key={stage.id} className="w-72 flex-shrink-0">
                  <div className="flex items-center gap-2 mb-2 px-1">
                    <div className="h-2.5 w-2.5 rounded-full" style={{ background: stage.color }} />
                    <span className="font-medium text-sm">{stage.name}</span>
                    <Badge variant="secondary" className="ml-auto text-xs">{stageDeals.length}</Badge>
                  </div>
                  <div className="px-1 mb-2 text-[11px] text-muted-foreground tabular-nums">
                    {stageValueTotal > 0 ? fmtCurrency(stageValueTotal) : "—"}
                  </div>
                  <div className="space-y-2 bg-muted/30 rounded-xl p-2 min-h-[120px]">
                    {stageDeals.map((rowRaw) => {
                      const row = rowRaw as Record<string, unknown>;
                      const deal = row.deal as Record<string, unknown> | undefined;
                      if (!deal) return null;
                      return (
                        <div key={String(deal.id)} className="bg-card rounded-lg border p-3 shadow-sm hover:shadow-md transition-shadow">
                          <p className="font-medium text-sm leading-tight truncate">{String(deal.title)}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">{String(row.contactFirstName ?? "")} {String(row.contactLastName ?? "")}</p>
                          <div className="flex items-center gap-2 mt-2">
                            {deal.valueEst != null && <span className="text-xs font-medium text-green-700 bg-green-50 px-1.5 py-0.5 rounded"><DollarSign className="h-2.5 w-2.5 inline mr-0.5" />{Number(deal.valueEst).toLocaleString()}</span>}
                            <Select value={String(deal.stageId)} onValueChange={(v) => moveStage(String(deal.id), v)}>
                              <SelectTrigger className="h-6 w-28 text-xs ml-auto"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {stages.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="flex gap-1.5 mt-2">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 px-2 text-[11px] flex-1 text-green-700 border-green-200 hover:bg-green-50"
                              onClick={() => closeDeal(String(deal.id), "won")}
                            >
                              Won
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 px-2 text-[11px] flex-1 text-red-700 border-red-200 hover:bg-red-50"
                              onClick={() => {
                                const reason = window.prompt("Reason for losing this deal? (optional)") ?? undefined;
                                void closeDeal(String(deal.id), "lost", reason);
                              }}
                            >
                              Lost
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                    {stageDeals.length === 0 && <p className="text-xs text-muted-foreground text-center py-4">No deals</p>}
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      )}

      {/* Add Deal Dialog */}
      <Dialog open={addDealOpen} onOpenChange={setAddDealOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>New Deal</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5"><Label>Contact ID *</Label><Input value={dealForm.contactId} onChange={(e) => setDealForm((f) => ({ ...f, contactId: e.target.value }))} /></div>
            <div className="space-y-1.5"><Label>Deal Title *</Label><Input value={dealForm.title} onChange={(e) => setDealForm((f) => ({ ...f, title: e.target.value }))} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Stage *</Label>
                <Select value={dealForm.stageId} onValueChange={(v) => setDealForm((f) => ({ ...f, stageId: v }))}>
                  <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                  <SelectContent>{stages.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5"><Label>Est. Value ($)</Label><Input type="number" value={dealForm.valueEst ?? ""} onChange={(e) => setDealForm((f) => ({ ...f, valueEst: e.target.value ? parseFloat(e.target.value) : null }))} /></div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddDealOpen(false)}>Cancel</Button>
            <Button onClick={handleCreateDeal}>Create Deal</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CreatePipelineDialog open={addPipelineOpen} onOpenChange={setAddPipelineOpen} form={pipelineForm} setForm={setPipelineForm} onSubmit={handleCreatePipeline} isPending={creatingPipeline} />
    </div>
  );
}

function CreatePipelineDialog({
  open, onOpenChange, form, setForm, onSubmit, isPending,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  form: { name: string; description?: string | null };
  setForm: (fn: (f: { name: string; description?: string | null }) => { name: string; description?: string | null }) => void;
  onSubmit: () => void;
  isPending: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>New Pipeline</DialogTitle></DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5"><Label>Name *</Label><Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></div>
          <div className="space-y-1.5"><Label>Description</Label><Input value={form.description ?? ""} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value || null }))} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={onSubmit} disabled={isPending}>{isPending ? "Creating…" : "Create"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ──────────────────────────────────────────────
// Inbox Tab
// ──────────────────────────────────────────────

function InboxTab() {
  const qc = useQueryClient();
  const [channelFilter, setChannelFilter] = useState("all");
  const [replyBody, setReplyBody] = useState("");
  const [selectedThread, setSelectedThread] = useState<string | null>(null);

  const { data: inboxData, isLoading } = useGetInbox({
    channel: channelFilter === "all" ? undefined : channelFilter as "sms",
    limit: 50,
  });
  const { data: threadsRaw } = useGetThreads({
    channel: channelFilter === "all" ? undefined : channelFilter as "sms",
    limit: 50,
  });
  const { mutateAsync: reply, isPending: replying } = useReplyInThread();
  const { mutateAsync: markRead } = useMarkMessageRead();

  const inboxItems: InboxResponseDataItem[] = inboxData?.data ?? [];
  const threadList: ThreadWithContact[] = threadsRaw ?? [];

  const handleReply = async () => {
    if (!selectedThread || !replyBody.trim()) return;
    try {
      await reply({ id: selectedThread, data: { body: replyBody } });
      toast.success("Reply sent");
      setReplyBody("");
      void qc.invalidateQueries({ queryKey: getGetInboxQueryKey() });
      void qc.invalidateQueries({ queryKey: getGetThreadsQueryKey() });
    } catch { toast.error("Failed to send reply"); }
  };

  const handleMarkRead = async (msgId: string) => {
    await markRead({ id: msgId });
    void qc.invalidateQueries({ queryKey: getGetInboxQueryKey() });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Select value={channelFilter} onValueChange={setChannelFilter}>
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All channels</SelectItem>
            <SelectItem value="sms">SMS</SelectItem>
            <SelectItem value="email">Email</SelectItem>
          </SelectContent>
        </Select>
        {inboxData && <Badge variant="secondary">{inboxData.total} unread</Badge>}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Thread list */}
        <div className="lg:col-span-2 space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Conversations</p>
          {isLoading ? (
            <div className="space-y-2">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-16 rounded-lg" />)}</div>
          ) : threadList.length === 0 ? (
            <div className="flex flex-col items-center py-12 text-center">
              <MessageSquare className="h-10 w-10 text-muted-foreground/20 mb-2" />
              <p className="text-sm text-muted-foreground">No conversations yet</p>
            </div>
          ) : (
            threadList.map((row) => {
              const rowExtra = row as ThreadWithContact & { unreadCount?: number; lastMessage?: string };
              const unread = rowExtra.unreadCount ?? 0;
              return (
                <div
                  key={row.thread.id}
                  className={cn("p-3 rounded-lg border cursor-pointer transition-colors", selectedThread === row.thread.id ? "bg-primary/5 border-primary/20" : "bg-card hover:bg-muted/20")}
                  onClick={() => setSelectedThread(row.thread.id)}
                >
                  <div className="flex items-center gap-2">
                    <div className={cn("h-2 w-2 rounded-full flex-shrink-0", row.thread.channel === "sms" ? "bg-blue-500" : "bg-purple-500")} />
                    <p className="font-medium text-sm">{row.contactFirstName} {row.contactLastName}</p>
                    {unread > 0 && <Badge className="ml-auto text-xs bg-red-500 text-white border-0">{unread}</Badge>}
                  </div>
                  {rowExtra.lastMessage && <p className="text-xs text-muted-foreground truncate mt-0.5 pl-4">{rowExtra.lastMessage}</p>}
                  <p className="text-xs text-muted-foreground/60 mt-0.5 pl-4 uppercase tracking-wide">{row.thread.channel}</p>
                </div>
              );
            })
          )}
        </div>

        {/* Reply panel */}
        <div className="lg:col-span-3">
          {selectedThread ? (
            <div className="border rounded-xl bg-card p-4 space-y-3">
              <p className="text-sm font-medium text-muted-foreground">Quick reply</p>
              <Textarea placeholder="Type your reply…" rows={4} value={replyBody} onChange={(e) => setReplyBody(e.target.value)} />
              <div className="flex justify-end">
                <Button size="sm" onClick={handleReply} disabled={replying || !replyBody.trim()}>
                  <Send className="h-4 w-4 mr-1" />{replying ? "Sending…" : "Send Reply"}
                </Button>
              </div>
            </div>
          ) : (
            <div className="border rounded-xl bg-muted/20 p-8 flex flex-col items-center justify-center text-center h-48">
              <MessageSquare className="h-10 w-10 text-muted-foreground/20 mb-2" />
              <p className="text-sm text-muted-foreground">Select a conversation to reply</p>
            </div>
          )}

          {inboxItems.length > 0 && (
            <div className="mt-4 space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Unread Messages</p>
              {inboxItems.map((rowRaw) => {
                const row = rowRaw as Record<string, unknown>;
                const msg = row.message as Record<string, unknown> | undefined;
                if (!msg) return null;
                return (
                  <div key={String(msg.id)} className="p-3 rounded-lg border bg-card">
                    <div className="flex items-start gap-3">
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium">{String(row.contactFirstName ?? "")} {String(row.contactLastName ?? "")}</p>
                          <Badge variant="outline" className="text-xs capitalize">{String(row.channel ?? "")}</Badge>
                        </div>
                        <p className="text-sm mt-1">{String(msg.body ?? "")}</p>
                        <p className="text-xs text-muted-foreground mt-1">{formatDistanceToNow(new Date(String(msg.createdAt)))} ago</p>
                      </div>
                      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => handleMarkRead(String(msg.id))}>
                        <CheckCircle2 className="h-3 w-3 mr-1" />Read
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────
// Sequences Tab
// ──────────────────────────────────────────────

function SequencesTab() {
  const qc = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
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
              <Button variant="outline" size="sm" className="h-7 text-xs shrink-0" onClick={() => toggleStatus(sequence.id, sequence.status)}>
                {sequence.status === "active" ? "Pause" : "Activate"}
              </Button>
            </div>
          ))}
        </div>
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

// ──────────────────────────────────────────────
// Retention Tab
// ──────────────────────────────────────────────

function RetentionTab() {
  const [, nav] = useLocation();
  const [section, setSection] = useState<"birthdays" | "at_risk" | "aep">("birthdays");

  const { data: summaryRaw } = useGetRetentionSummary();
  const { data: birthdaysRaw, isLoading: bLoading } = useGetRetentionBirthdays({ days: 30 });
  const { data: atRiskRaw, isLoading: arLoading } = useGetRetentionAtRisk({ days: 60 });
  const { data: aepRaw, isLoading: aepLoading } = useGetRetentionAep({});

  const summary = summaryRaw as RetentionSummary | undefined;
  const birthdays: Contact[] = birthdaysRaw ?? [];
  const atRisk: Contact[] = atRiskRaw ?? [];
  const aep: Contact[] = aepRaw ?? [];

  const renderContactRow = (c: Contact) => (
    <div key={c.id} className="flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-muted/20 cursor-pointer" onClick={() => nav(`/crm/contacts/${c.id}`)}>
      <Avatar className="h-8 w-8 shrink-0">
        <AvatarFallback className="text-xs bg-primary/10 text-primary">{initials(c.firstName, c.lastName)}</AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm">{c.firstName} {c.lastName}</p>
        <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
          {c.currentPlanType && <span>{PLAN_TYPE_LABELS[c.currentPlanType] ?? c.currentPlanType}</span>}
          {c.dob && section === "birthdays" && <span>{format(new Date(c.dob), "MMMM d")}</span>}
          {c.stateCode && <span>{c.stateCode}</span>}
        </div>
      </div>
      <Badge className={cn("text-xs border-0 shrink-0", CONTACT_STATUS_STYLES[c.status] ?? "")}>{c.status}</Badge>
      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <Card className={cn("py-3 cursor-pointer transition-colors", section === "birthdays" && "ring-2 ring-primary")} onClick={() => setSection("birthdays")}>
          <CardContent className="px-4 py-0 flex items-center gap-3">
            <Cake className="h-8 w-8 text-pink-500 shrink-0" />
            <div><p className="text-xl font-bold">{String(summary?.birthdaysInNext30Days ?? "—")}</p><p className="text-xs text-muted-foreground">Birthdays (30d)</p></div>
          </CardContent>
        </Card>
        <Card className={cn("py-3 cursor-pointer transition-colors", section === "at_risk" && "ring-2 ring-primary")} onClick={() => setSection("at_risk")}>
          <CardContent className="px-4 py-0 flex items-center gap-3">
            <AlertTriangle className="h-8 w-8 text-amber-500 shrink-0" />
            <div><p className="text-xl font-bold">{String(summary?.atRiskContacts ?? "—")}</p><p className="text-xs text-muted-foreground">At-Risk (60d)</p></div>
          </CardContent>
        </Card>
        <Card className={cn("py-3 cursor-pointer transition-colors", section === "aep" && "ring-2 ring-primary")} onClick={() => setSection("aep")}>
          <CardContent className="px-4 py-0 flex items-center gap-3">
            <Calendar className="h-8 w-8 text-blue-500 shrink-0" />
            <div><p className="text-xl font-bold">{aep.length}</p><p className="text-xs text-muted-foreground">AEP Eligible</p></div>
          </CardContent>
        </Card>
      </div>

      {section === "birthdays" && (
        <div>
          <p className="text-sm font-medium mb-3 flex items-center gap-2"><Cake className="h-4 w-4 text-pink-500" />Upcoming Birthdays — Next 30 Days</p>
          {bLoading ? <Skeleton className="h-32 rounded-xl" /> : birthdays.length === 0 ? (
            <div className="text-center py-10 text-sm text-muted-foreground">No birthdays in the next 30 days</div>
          ) : <div className="space-y-2">{birthdays.map(renderContactRow)}</div>}
        </div>
      )}

      {section === "at_risk" && (
        <div>
          <p className="text-sm font-medium mb-3 flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-500" />At-Risk Contacts — No activity in 60+ days</p>
          {arLoading ? <Skeleton className="h-32 rounded-xl" /> : atRisk.length === 0 ? (
            <div className="text-center py-10 text-sm text-muted-foreground">No at-risk contacts</div>
          ) : <div className="space-y-2">{atRisk.map(renderContactRow)}</div>}
        </div>
      )}

      {section === "aep" && (
        <div>
          <p className="text-sm font-medium mb-3 flex items-center gap-2"><Calendar className="h-4 w-4 text-blue-500" />AEP-Eligible Contacts</p>
          {aepLoading ? <Skeleton className="h-32 rounded-xl" /> : aep.length === 0 ? (
            <div className="text-center py-10 text-sm text-muted-foreground">No AEP-eligible contacts found</div>
          ) : <div className="space-y-2">{aep.map(renderContactRow)}</div>}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────
// Main CRM Page
// ──────────────────────────────────────────────

export default function CRMPage() {
  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">CRM</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Contacts, leads, pipelines, inbox, sequences, and retention</p>
      </div>
      <Tabs defaultValue="contacts" className="space-y-4">
        <TabsList className="flex-wrap h-auto gap-1 bg-muted/40 p-1">
          <TabsTrigger value="contacts" className="gap-1.5"><Users className="h-4 w-4" />Contacts</TabsTrigger>
          <TabsTrigger value="leads" className="gap-1.5"><Target className="h-4 w-4" />Leads</TabsTrigger>
          <TabsTrigger value="pipeline" className="gap-1.5"><TrendingUp className="h-4 w-4" />Pipeline</TabsTrigger>
          <TabsTrigger value="inbox" className="gap-1.5"><Inbox className="h-4 w-4" />Inbox</TabsTrigger>
          <TabsTrigger value="sequences" className="gap-1.5"><Workflow className="h-4 w-4" />Sequences</TabsTrigger>
          <TabsTrigger value="retention" className="gap-1.5"><Shield className="h-4 w-4" />Retention</TabsTrigger>
        </TabsList>
        <TabsContent value="contacts"><ContactsTab /></TabsContent>
        <TabsContent value="leads"><LeadsTab /></TabsContent>
        <TabsContent value="pipeline"><PipelineTab /></TabsContent>
        <TabsContent value="inbox"><InboxTab /></TabsContent>
        <TabsContent value="sequences"><SequencesTab /></TabsContent>
        <TabsContent value="retention"><RetentionTab /></TabsContent>
      </Tabs>
    </div>
  );
}
