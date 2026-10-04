/**
 * Add a policy — record a client's plan on the real `enrollments` table
 * (`POST /api/enrollments`). Used from the Policies page (pick the client) and
 * from a client's own page (client already known).
 *
 * The server checks everything that matters (client, carrier and agent must
 * belong to this agency; the same client can't have the same carrier + plan
 * type + year twice). This form only asks for the right things and turns the
 * server's answers into plain words.
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, X } from "lucide-react";
import { customFetch, useGetCarriers } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AgentPicker } from "@/components/shared";
import { useToast } from "@/hooks/use-toast";

/** Roles that may record a policy (server: contact:create). */
export const POLICY_CREATE_ROLES = ["super_admin", "agency_admin", "compliance_manager", "agent_support"];

const PLAN_TYPES: { value: string; label: string }[] = [
  { value: "MAPD", label: "Medicare Advantage + Drug (MAPD)" },
  { value: "MA", label: "Medicare Advantage (MA)" },
  { value: "PDP", label: "Part D drug plan (PDP)" },
  { value: "supp", label: "Medicare Supplement" },
  { value: "other", label: "Other" },
];

const STATUSES: { value: string; label: string }[] = [
  { value: "pending", label: "Pending — applied, carrier hasn't confirmed" },
  { value: "active", label: "Active — in force" },
  { value: "terminated", label: "Terminated — ended after starting" },
  { value: "cancelled", label: "Cancelled — never started" },
  { value: "declined", label: "Declined by the carrier" },
];

const NONE = "__none__";

type ClientChoice = { id: string; name: string };
type ContactLite = { id: string; firstName?: string | null; lastName?: string | null };

function nameOf(c: ContactLite): string {
  return `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || "Unnamed client";
}

/** The server's own message when it sent one, otherwise a plain fallback. */
export function apiMessage(err: unknown, fallback: string): string {
  const e = err as { data?: { error?: string }; message?: string } | null;
  return e?.data?.error ?? fallback;
}

export function AddPolicyDialog({
  open,
  onOpenChange,
  contact,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Set when the client is already known (a client's own page). */
  contact?: ClientChoice;
  onSaved?: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: carriers } = useGetCarriers();

  const [client, setClient] = useState<ClientChoice | null>(contact ?? null);
  const [clientSearch, setClientSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [carrierId, setCarrierId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [planType, setPlanType] = useState("");
  const [planYear, setPlanYear] = useState(String(new Date().getFullYear()));
  const [yearTouched, setYearTouched] = useState(false);
  const [planName, setPlanName] = useState("");
  const [policyNumber, setPolicyNumber] = useState("");
  const [applicationDate, setApplicationDate] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [status, setStatus] = useState("pending");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(clientSearch.trim()), 250);
    return () => clearTimeout(t);
  }, [clientSearch]);

  // Keep the form in step with the client page it was opened from.
  useEffect(() => {
    if (contact) setClient(contact);
  }, [contact?.id, contact?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  const search = useQuery({
    queryKey: ["/api/contacts", "policy-picker", debounced],
    queryFn: () => customFetch<{ data: ContactLite[] }>(`/api/contacts?search=${encodeURIComponent(debounced)}&limit=8`),
    enabled: open && !client && debounced.length >= 2,
  });
  const matches = search.data?.data ?? [];

  const reset = () => {
    setClient(contact ?? null);
    setClientSearch("");
    setDebounced("");
    setCarrierId("");
    setAgentId("");
    setPlanType("");
    setPlanYear(String(new Date().getFullYear()));
    setYearTouched(false);
    setPlanName("");
    setPolicyNumber("");
    setApplicationDate("");
    setEffectiveDate("");
    setStatus("pending");
    setNotes("");
    setError(null);
  };

  const onEffectiveChange = (value: string) => {
    setEffectiveDate(value);
    // A plan's year is almost always the year it starts; follow it until the user types their own.
    if (!yearTouched && /^\d{4}-\d{2}-\d{2}$/.test(value)) setPlanYear(value.slice(0, 4));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const year = Number(planYear);
    if (!client) return setError("Choose the client this policy belongs to.");
    if (!planType) return setError("Choose the plan type.");
    if (!Number.isInteger(year) || year < 2000 || year > 2100) return setError("Enter a plan year like 2026.");
    if (!effectiveDate) return setError("Enter the date the policy starts.");
    setError(null);
    setSaving(true);
    try {
      await customFetch("/api/enrollments", {
        method: "POST",
        body: JSON.stringify({
          contactId: client.id,
          carrierId: carrierId || null,
          agentId: agentId || null,
          planType,
          planYear: year,
          planName: planName.trim() || null,
          policyNumber: policyNumber.trim() || null,
          applicationDate: applicationDate || null,
          effectiveDate,
          status,
          // "Active" means in force, so it is also marked as having taken effect.
          effectuated: status === "active",
          notes: notes.trim() || null,
        }),
      });
      toast({ title: "Policy added", description: `${client.name} · ${PLAN_TYPES.find((p) => p.value === planType)?.label ?? planType} · ${year}` });
      void qc.invalidateQueries({ queryKey: ["/api/enrollments"] });
      void qc.invalidateQueries({ queryKey: ["/api/enrollments/summary"] });
      onSaved?.();
      onOpenChange(false);
      reset();
    } catch (err) {
      setError(apiMessage(err, "Couldn't save that policy. Please check the details and try again."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) reset(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display">Add policy</DialogTitle>
          <DialogDescription>Record the plan a client is enrolled in. Carrier, agent and the rest can be filled in later.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <Label htmlFor="ap-client">Client *</Label>
            {client ? (
              <div className="mt-1 flex items-center justify-between rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
                <span className="font-medium">{client.name}</span>
                {!contact && (
                  <Button type="button" variant="ghost" size="icon" className="h-6 w-6" aria-label="Choose a different client" onClick={() => setClient(null)}>
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ) : (
              <div className="mt-1">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input id="ap-client" value={clientSearch} onChange={(e) => setClientSearch(e.target.value)} placeholder="Search by name, email or phone…" className="pl-9" autoComplete="off" />
                </div>
                {debounced.length >= 2 && (
                  <ul className="mt-1 max-h-48 overflow-y-auto rounded-md border border-border bg-popover text-sm" role="listbox" aria-label="Matching clients">
                    {search.isLoading ? (
                      <li className="px-3 py-2 text-muted-foreground">Searching…</li>
                    ) : matches.length === 0 ? (
                      <li className="px-3 py-2 text-muted-foreground">No clients match “{debounced}”.</li>
                    ) : (
                      matches.map((m) => (
                        <li key={m.id} role="option" aria-selected={false}>
                          <button type="button" className="w-full px-3 py-2 text-left hover:bg-accent/10" onClick={() => { setClient({ id: m.id, name: nameOf(m) }); setClientSearch(""); }}>
                            {nameOf(m)}
                          </button>
                        </li>
                      ))
                    )}
                  </ul>
                )}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="ap-plan-type">Plan type *</Label>
              <Select value={planType || undefined} onValueChange={setPlanType}>
                <SelectTrigger id="ap-plan-type" className="mt-1"><SelectValue placeholder="Choose a plan type" /></SelectTrigger>
                <SelectContent>{PLAN_TYPES.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="ap-carrier">Carrier</Label>
              <Select value={carrierId || NONE} onValueChange={(v) => setCarrierId(v === NONE ? "" : v)}>
                <SelectTrigger id="ap-carrier" className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Not sure yet</SelectItem>
                  {(carriers ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="ap-effective">Starts on *</Label>
              <Input id="ap-effective" type="date" value={effectiveDate} onChange={(e) => onEffectiveChange(e.target.value)} className="mt-1" />
            </div>
            <div>
              <Label htmlFor="ap-year">Plan year *</Label>
              <Input id="ap-year" type="number" min={2000} max={2100} value={planYear} onChange={(e) => { setYearTouched(true); setPlanYear(e.target.value); }} className="mt-1" />
            </div>
            <div>
              <Label htmlFor="ap-plan-name">Plan name</Label>
              <Input id="ap-plan-name" value={planName} onChange={(e) => setPlanName(e.target.value)} placeholder="e.g. Gold Plus HMO" className="mt-1" maxLength={200} />
            </div>
            <div>
              <Label htmlFor="ap-policy-number">Policy number</Label>
              <Input id="ap-policy-number" value={policyNumber} onChange={(e) => setPolicyNumber(e.target.value)} className="mt-1" maxLength={100} />
            </div>
            <div>
              <Label htmlFor="ap-application">Application date</Label>
              <Input id="ap-application" type="date" value={applicationDate} onChange={(e) => setApplicationDate(e.target.value)} className="mt-1" />
            </div>
            <div>
              <Label>Writing agent</Label>
              <AgentPicker value={agentId} onChange={setAgentId} noneLabel="Not assigned" className="mt-1" aria-label="Writing agent" />
            </div>
          </div>

          <div>
            <Label htmlFor="ap-status">Status</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger id="ap-status" className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>{STATUSES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="ap-notes">Notes</Label>
            <Textarea id="ap-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1" maxLength={2000} />
          </div>

          {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Add policy"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
