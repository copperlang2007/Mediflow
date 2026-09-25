import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  LeadListResponseDataItem, LeadStats, Contact,
  CreateLeadBody, UpdateLeadBody,
} from "@workspace/api-client-react";
import {
  useGetLeads, useGetContacts, useCreateLead, useUpdateLead, useConvertLead, useGetLeadStats,
  getGetLeadsQueryKey, getGetLeadStatsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Plus, Target, ArrowRight, Star, CircleHelp } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { LEAD_STATUS_STYLES, initials } from "./shared";


function FieldHelp({ label, children }: { label: string; children: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`About ${label}`}
          aria-description={children}
          className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <CircleHelp className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-sm">{children}</TooltipContent>
    </Tooltip>
  );
}

export function leadCreateErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const data = (error as { data?: unknown }).data;
    if (data && typeof data === "object") {
      const message = (data as { error?: unknown }).error;
      if (typeof message === "string" && message.trim()) return message;
    }
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message.replace(/^HTTP \\d+[^:]*:\\s*/, "");
  }
  return "Failed to create lead";
}

export default function LeadsTab() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("all");
  const [addOpen, setAddOpen] = useState(false);
  const [contactSearch, setContactSearch] = useState("");
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [form, setForm] = useState<CreateLeadBody>({ contactId: "", source: null, sourceDetail: null, score: 0, status: "new" });

  const { data, isLoading } = useGetLeads({ status: statusFilter === "all" ? undefined : statusFilter, limit: 100 });
  const { data: stats } = useGetLeadStats();
  const { data: contactsData, isLoading: contactsLoading } = useGetContacts({ search: contactSearch || undefined, limit: 100 });
  const { mutateAsync: createLead, isPending } = useCreateLead();
  const { mutateAsync: convertLead } = useConvertLead();
  const { mutateAsync: updateLead } = useUpdateLead();

  const leads: LeadListResponseDataItem[] = data?.data ?? [];
  const leadStats = stats as LeadStats | undefined;
  const contacts: Contact[] = contactsData?.data ?? [];

  const handleCreate = async () => {
    if (!form.contactId) { toast.error("Select a contact"); return; }
    try {
      await createLead({ data: form });
      toast.success("Lead created");
      setAddOpen(false);
      void qc.invalidateQueries({ queryKey: getGetLeadsQueryKey() });
      void qc.invalidateQueries({ queryKey: getGetLeadStatsQueryKey() });
    } catch (error) { toast.error(leadCreateErrorMessage(error)); }
  };

  const handleConvert = async (id: string) => {
    try {
      await convertLead({ id });
      toast.success("Lead converted to prospect");
      void qc.invalidateQueries({ queryKey: getGetLeadsQueryKey() });
      void qc.invalidateQueries({ queryKey: getGetLeadStatsQueryKey() });
    } catch { toast.error("Conversion failed"); }
  };

  const handleUpdateStatus = async (id: string, status: string) => {
    await updateLead({ id, data: { status } satisfies UpdateLeadBody });
    void qc.invalidateQueries({ queryKey: getGetLeadsQueryKey() });
    void qc.invalidateQueries({ queryKey: getGetLeadStatsQueryKey() });
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
          <DialogHeader>
            <DialogTitle>New Lead</DialogTitle>
            <DialogDescription>
              Connect an existing CRM contact to a new sales opportunity.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Label htmlFor="lead-contact">Contact *</Label>
                <FieldHelp label="contact">The person this sales opportunity belongs to.</FieldHelp>
              </div>
              <Input
                aria-label="Search contacts"
                placeholder="Search contacts by name, email, or phone"
                value={contactSearch}
                onChange={(e) => setContactSearch(e.target.value)}
                className="mb-2"
              />
              <Select value={form.contactId} onValueChange={(value) => {
                setForm((f) => ({ ...f, contactId: value }));
                setSelectedContact(contacts.find((contact) => contact.id === value) ?? null);
              }}>
                <SelectTrigger id="lead-contact" aria-label="Contact">
                  <SelectValue placeholder={contactsLoading ? "Loading contacts…" : "Select a contact…"} />
                </SelectTrigger>
                <SelectContent>
                  {selectedContact && !contacts.some((contact) => contact.id === selectedContact.id) && (
                    <SelectItem value={selectedContact.id}>{selectedContact.firstName} {selectedContact.lastName}</SelectItem>
                  )}
                  {contacts.map((contact) => (
                    <SelectItem key={contact.id} value={contact.id}>
                      {contact.firstName} {contact.lastName}
                      {contact.email ? ` — ${contact.email}` : contact.phone ? ` — ${contact.phone}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!contactsLoading && contacts.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No contacts yet. Create a contact before creating a lead.
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <Label htmlFor="lead-source">Source</Label>
                  <FieldHelp label="source">Where this lead came from, such as Referral, Website, or Direct Mail.</FieldHelp>
                </div>
                <Input id="lead-source" placeholder="e.g. Web form" value={form.source ?? ""} onChange={(e) => setForm((f) => ({ ...f, source: e.target.value || null }))} />
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <Label htmlFor="lead-score">Score (0–100)</Label>
                  <FieldHelp label="score">Lead priority from 0 to 100. Higher scores indicate stronger opportunities.</FieldHelp>
                </div>
                <Input id="lead-score" type="number" min="0" max="100" value={form.score ?? 0} onChange={(e) => setForm((f) => ({ ...f, score: parseInt(e.target.value) || 0 }))} />
              </div>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Label htmlFor="lead-status">Status</Label>
                <FieldHelp label="status">New means not yet contacted; Contacted means outreach started; Qualified means ready for the next sales step.</FieldHelp>
              </div>
              <Select value={form.status ?? "new"} onValueChange={(v) => setForm((f) => ({ ...f, status: v }))}>
                <SelectTrigger id="lead-status" aria-label="Status"><SelectValue /></SelectTrigger>
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
            <Button onClick={handleCreate} disabled={isPending || contactsLoading || contacts.length === 0 || !form.contactId}>
              {isPending ? "Creating…" : "Create Lead"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
