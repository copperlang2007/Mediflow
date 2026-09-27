import { useEffect, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import type {
  Contact,
  CreateContactBody, BulkContactActionBody,
} from "@workspace/api-client-react";
import {
  useGetContacts, useCreateContact, useBulkContactAction,
  getGetContactsQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Users, Plus, Search, Mail, Phone, ChevronRight, MoreHorizontal, UserCheck, UserPlus, Sparkles, UserX,
} from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { EmptyState, KpiCard, StatusPill } from "@/components/shared";
import { PLAN_TYPE_LABELS } from "./shared";
import { ContactAvatar, ListCard, Th } from "./ui";

/**
 * Head-count for one contact status. Asks the list endpoint for a single row
 * and reads its `total`, so the number always matches the real database.
 */
function useStatusCount(status: string) {
  const { data, isLoading } = useGetContacts({ status, limit: 1 });
  return { count: data?.total, isLoading };
}

export default function ContactsTab() {
  const [, nav] = useLocation();
  const qc = useQueryClient();
  // `/crm?q=…` (from the top-bar search) pre-fills the search box.
  const urlQuery = new URLSearchParams(useSearch()).get("q") ?? "";
  const [search, setSearch] = useState(urlQuery);
  useEffect(() => {
    if (urlQuery) setSearch(urlQuery);
  }, [urlQuery]);
  const [statusFilter, setStatusFilter] = useState("all");
  const [planFilter, setPlanFilter] = useState("all");
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
    planType: planFilter === "all" ? undefined : planFilter,
    limit: 100,
  });
  const { mutateAsync: createContact, isPending } = useCreateContact();
  const { mutateAsync: bulkMutate } = useBulkContactAction();

  const enrolled = useStatusCount("enrolled");
  const retained = useStatusCount("retained");
  const prospects = useStatusCount("prospect");
  const leads = useStatusCount("lead");
  const lost = useStatusCount("lost");
  const clientsCount =
    enrolled.count === undefined || retained.count === undefined
      ? undefined
      : enrolled.count + retained.count;

  const contacts: Contact[] = data?.data ?? [];
  const filtersActive = Boolean(search) || statusFilter !== "all" || planFilter !== "all";

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
    <div className="space-y-6">
      {/* Headline counts — straight from the contacts table. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard variant="white" color="green" icon={UserCheck} label="Clients (enrolled)" value={clientsCount ?? "—"} loading={enrolled.isLoading || retained.isLoading} />
        <KpiCard variant="white" color="blue" icon={Sparkles} label="Prospects" value={prospects.count ?? "—"} loading={prospects.isLoading} />
        <KpiCard variant="white" color="navy" icon={UserPlus} label="Leads" value={leads.count ?? "—"} loading={leads.isLoading} />
        <KpiCard variant="white" color="orange" icon={UserX} label="Lost" value={lost.count ?? "—"} loading={lost.isLoading} />
      </div>

      <ListCard
        toolbar={
          <>
            <div className="relative flex-1 md:max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input aria-label="Search contacts" placeholder="Search by name, phone, email or Medicare ID…" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <div className="flex flex-wrap items-center gap-2 md:ml-auto">
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[150px]" aria-label="Filter by status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="lead">Lead</SelectItem>
                  <SelectItem value="prospect">Prospect</SelectItem>
                  <SelectItem value="enrolled">Enrolled</SelectItem>
                  <SelectItem value="retained">Retained</SelectItem>
                  <SelectItem value="lost">Lost</SelectItem>
                </SelectContent>
              </Select>
              <Select value={planFilter} onValueChange={setPlanFilter}>
                <SelectTrigger className="w-[170px]" aria-label="Filter by plan"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All plans</SelectItem>
                  {Object.entries(PLAN_TYPE_LABELS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
                </SelectContent>
              </Select>
              {selected.length > 0 && (
                <Button variant="outline" onClick={() => setBulkOpen(true)}>
                  <MoreHorizontal className="h-4 w-4 mr-1.5" />Actions for {selected.length}
                </Button>
              )}
              <Button onClick={() => setAddOpen(true)}><Plus className="h-4 w-4 mr-1.5" />New Contact</Button>
            </div>
          </>
        }
      >
        {isLoading ? (
          <div className="space-y-2">{[...Array(6)].map((_, i) => <Skeleton key={i} className="h-14 w-full rounded-lg" />)}</div>
        ) : contacts.length === 0 ? (
          filtersActive ? (
            <EmptyState
              icon={Search}
              title="No one matches that search"
              description="Try a different name or phone number, or clear the filters to see everyone."
              action={{ label: "Clear filters", onClick: () => { setSearch(""); setStatusFilter("all"); setPlanFilter("all"); } }}
            />
          ) : (
            <EmptyState
              icon={Users}
              title="No contacts yet"
              description="Everyone you talk to — leads, prospects and enrolled clients — lives here. Add your first contact to get started."
              action={{ label: "Add a contact", onClick: () => setAddOpen(true) }}
            />
          )
        ) : (
          <div className="rounded-lg border border-border overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 border-b border-border">
                <tr>
                  <th className="w-10 pl-4 py-3 text-left">
                    <Checkbox aria-label="Select all" checked={selected.length === contacts.length && contacts.length > 0} onCheckedChange={toggleAll} />
                  </th>
                  <Th>Client</Th>
                  <Th>Status</Th>
                  <Th className="hidden lg:table-cell">Plan</Th>
                  <Th className="hidden md:table-cell">Phone</Th>
                  <Th className="hidden xl:table-cell">Source</Th>
                  <Th className="hidden xl:table-cell">Added</Th>
                  <th className="w-8 px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {contacts.map((c) => (
                  <tr key={c.id} className="hover:bg-muted/30 transition-colors cursor-pointer" onClick={() => nav(`/crm/contacts/${c.id}`)}>
                    <td className="pl-4 py-3" onClick={(e) => { e.stopPropagation(); toggleSelect(c.id); }}>
                      <Checkbox aria-label={`Select ${c.firstName} ${c.lastName}`} checked={selected.includes(c.id)} onCheckedChange={() => toggleSelect(c.id)} />
                    </td>
                    <td className="px-4 py-3 max-w-[320px]">
                      <div className="flex items-center gap-3 min-w-0">
                        <ContactAvatar first={c.firstName} last={c.lastName} />
                        <div className="min-w-0">
                          <p className="font-medium leading-tight truncate">{c.firstName} {c.lastName}</p>
                          {c.email ? (
                            <p className="text-xs text-muted-foreground truncate flex items-center gap-1" title={c.email}>
                              <Mail className="h-3 w-3 shrink-0" />{c.email}
                            </p>
                          ) : c.medicareId ? (
                            <p className="text-xs text-muted-foreground truncate">Medicare ID {c.medicareId}</p>
                          ) : null}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3"><StatusPill status={c.status} /></td>
                    <td className="px-4 py-3 hidden lg:table-cell whitespace-nowrap">
                      {c.currentPlanType ? (
                        <span className="text-sm">
                          {PLAN_TYPE_LABELS[c.currentPlanType] ?? c.currentPlanType}
                          {c.planYear && <span className="text-muted-foreground ml-1">· {c.planYear}</span>}
                        </span>
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell whitespace-nowrap text-muted-foreground">
                      {c.phone ? <span className="inline-flex items-center gap-1.5"><Phone className="h-3.5 w-3.5 shrink-0" />{c.phone}</span> : "—"}
                    </td>
                    <td className="px-4 py-3 hidden xl:table-cell text-muted-foreground whitespace-nowrap">{c.leadSource ?? "—"}</td>
                    <td className="px-4 py-3 hidden xl:table-cell text-muted-foreground whitespace-nowrap">{format(new Date(c.createdAt), "MMM d, yyyy")}</td>
                    <td className="px-4 py-3"><ChevronRight className="h-4 w-4 text-muted-foreground" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!isLoading && contacts.length > 0 && (
          <p className="mt-3 px-1 text-sm text-muted-foreground">
            Showing {contacts.length} of {data?.total ?? contacts.length} contacts
            {(data?.total ?? 0) > contacts.length && " — search to narrow the list"}
          </p>
        )}
      </ListCard>

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
