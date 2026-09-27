/**
 * Create / edit an appointment (stage2/calendar-branding).
 *
 * Used by the Calendar page and by the "Book appointment" button on a
 * contact's page. Everything it writes goes through the real API; the agent
 * picker and contact picker only offer what the server would accept for the
 * caller (agents: themselves and their own contacts).
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { Lock, Search, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  APPOINTMENT_STATUSES,
  APPOINTMENT_TYPES,
  LOCATION_LABELS,
  LOCATION_TYPES,
  STATUS_LABELS,
  TYPE_LABELS,
  createAppointment,
  deleteAppointment,
  listAgentOptions,
  searchContactOptions,
  updateAppointment,
  type Appointment,
  type AppointmentInput,
  type AppointmentStatus,
  type AppointmentType,
  type LocationType,
} from "@/lib/appointments";

const DURATIONS = [15, 30, 45, 60, 90, 120];

interface FormState {
  title: string;
  type: AppointmentType;
  status: AppointmentStatus;
  date: string;
  time: string;
  duration: number;
  contact: { id: string; name: string } | null;
  agentId: string;
  locationType: LocationType;
  locationDetail: string;
  meetingUrl: string;
  notes: string;
}

function initialState(appt: Appointment | null | undefined, defaults: AppointmentDialogProps["defaults"]): FormState {
  if (appt) {
    const s = new Date(appt.startsAt);
    const e = new Date(appt.endsAt);
    const mins = Math.max(5, Math.round((e.getTime() - s.getTime()) / 60_000));
    const contactName = appt.contact
      ? [appt.contact.firstName, appt.contact.lastName].filter(Boolean).join(" ")
      : "";
    return {
      title: appt.title,
      type: appt.type,
      status: appt.status,
      date: format(s, "yyyy-MM-dd"),
      time: format(s, "HH:mm"),
      duration: mins,
      contact: appt.contactId ? { id: appt.contactId, name: contactName || "Client" } : null,
      agentId: appt.agentId ?? "",
      locationType: appt.locationType,
      locationDetail: appt.locationDetail ?? "",
      meetingUrl: appt.meetingUrl ?? "",
      notes: appt.notes ?? "",
    };
  }
  const date = defaults?.date ?? new Date();
  return {
    title: defaults?.contact ? `Meeting with ${defaults.contact.name}` : "",
    type: "consultation",
    status: "confirmed",
    date: format(date, "yyyy-MM-dd"),
    time: "10:00",
    duration: 30,
    contact: defaults?.contact ?? null,
    agentId: "",
    locationType: "phone",
    locationDetail: "",
    meetingUrl: "",
    notes: "",
  };
}

export interface AppointmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appointment?: Appointment | null;
  defaults?: { date?: Date; contact?: { id: string; name: string } };
  canDelete?: boolean;
  onSaved?: (appt: Appointment) => void;
}

export function AppointmentDialog({
  open,
  onOpenChange,
  appointment,
  defaults,
  canDelete = false,
  onSaved,
}: AppointmentDialogProps) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState<FormState>(() => initialState(appointment, defaults));
  const [contactSearch, setContactSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const editing = Boolean(appointment);

  useEffect(() => {
    if (open) {
      setForm(initialState(appointment, defaults));
      setContactSearch("");
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, appointment?.id]);

  const agents = useQuery({
    queryKey: ["/api/appointments/agent-options"],
    queryFn: listAgentOptions,
    enabled: open,
    staleTime: 60_000,
  });
  const contacts = useQuery({
    queryKey: ["/api/appointments/contact-options", contactSearch],
    queryFn: () => searchContactOptions(contactSearch),
    enabled: open && !form.contact,
    staleTime: 30_000,
  });

  const agentList = agents.data?.data ?? [];
  const onlySelf = agentList.length === 1 && agentList[0].isMe;

  // Default the agent to "me" when the caller has an agent profile.
  useEffect(() => {
    if (!open || editing || form.agentId) return;
    const me = agentList.find((a) => a.isMe);
    if (me) setForm((f) => ({ ...f, agentId: me.id }));
  }, [open, editing, agentList, form.agentId]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const payload = useMemo((): AppointmentInput | null => {
    if (!form.date || !form.time) return null;
    const start = new Date(`${form.date}T${form.time}`);
    if (Number.isNaN(start.getTime())) return null;
    const end = new Date(start.getTime() + form.duration * 60_000);
    return {
      title: form.title.trim(),
      type: form.type,
      status: form.status,
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      contactId: form.contact?.id ?? null,
      agentId: form.agentId || null,
      notes: form.notes.trim() || null,
      locationType: form.locationType,
      locationDetail: form.locationType !== "video" ? form.locationDetail.trim() || null : null,
      meetingUrl: form.locationType === "video" ? form.meetingUrl.trim() || null : null,
    };
  }, [form]);

  const save = useMutation({
    mutationFn: async () => {
      if (!payload) throw new Error("Pick a date and time.");
      if (!payload.title) throw new Error("Give the appointment a short title.");
      const body = { ...payload };
      // Leave masked notes untouched when editing without permission to read them.
      if (editing && appointment?.notesMasked) delete (body as Partial<AppointmentInput>).notes;
      return editing ? updateAppointment(appointment!.id, body) : createAppointment(body);
    },
    onSuccess: async (appt) => {
      await qc.invalidateQueries({ queryKey: ["/api/appointments"] });
      toast({
        title: editing ? "Appointment updated" : "Appointment booked",
        description: `${appt.title} · ${format(new Date(appt.startsAt), "EEE, MMM d 'at' h:mm a")}`,
      });
      onSaved?.(appt);
      onOpenChange(false);
    },
    onError: (err: Error) => setError(err.message),
  });

  const remove = useMutation({
    mutationFn: () => deleteAppointment(appointment!.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["/api/appointments"] });
      toast({ title: "Appointment deleted" });
      onOpenChange(false);
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display">{editing ? "Edit appointment" : "New appointment"}</DialogTitle>
          <DialogDescription>
            Clients with a phone or email on file get a reminder the day before (unless they opted out).
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            save.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="appt-title">Title</Label>
            <Input
              id="appt-title"
              value={form.title}
              maxLength={200}
              onChange={(e) => set("title", e.target.value)}
              placeholder="Annual plan review"
              required
            />
            <p className="text-xs text-muted-foreground">Shown on the shared calendar — keep health details in the notes.</p>
          </div>

          <div className="space-y-1.5">
            <Label>Client</Label>
            {form.contact ? (
              <div className="flex items-center justify-between rounded-md border border-input bg-muted/40 px-3 py-2 text-sm">
                <span className="font-medium">{form.contact.name}</span>
                <Button type="button" variant="ghost" size="sm" className="h-6 px-1.5" onClick={() => set("contact", null)} aria-label="Remove client">
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ) : (
              <div className="rounded-md border border-input">
                <div className="flex items-center gap-2 border-b border-border px-3">
                  <Search className="h-4 w-4 text-muted-foreground" />
                  <input
                    className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                    placeholder="Search clients by name (optional)"
                    value={contactSearch}
                    onChange={(e) => setContactSearch(e.target.value)}
                    aria-label="Search clients"
                  />
                </div>
                <div className="max-h-36 overflow-y-auto py-1" role="listbox" aria-label="Clients">
                  {contacts.isLoading ? (
                    <p className="px-3 py-2 text-xs text-muted-foreground">Searching…</p>
                  ) : (contacts.data?.data ?? []).length === 0 ? (
                    <p className="px-3 py-2 text-xs text-muted-foreground">
                      {contacts.isError ? "Could not load clients." : "No matching clients you can book."}
                    </p>
                  ) : (
                    contacts.data!.data.map((c) => (
                      <button
                        type="button"
                        role="option"
                        aria-selected={false}
                        key={c.id}
                        className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted"
                        onClick={() => {
                          const name = `${c.firstName} ${c.lastName}`.trim();
                          setForm((f) => ({
                            ...f,
                            contact: { id: c.id, name },
                            title: f.title || `Meeting with ${name}`,
                            agentId: f.agentId || c.assignedAgentId || "",
                          }));
                        }}
                      >
                        {c.firstName} {c.lastName}
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select value={form.type} onValueChange={(v) => set("type", v as AppointmentType)}>
                <SelectTrigger aria-label="Appointment type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {APPOINTMENT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{TYPE_LABELS[t]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select value={form.status} onValueChange={(v) => set("status", v as AppointmentStatus)}>
                <SelectTrigger aria-label="Status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {APPOINTMENT_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="appt-date">Date</Label>
              <Input id="appt-date" type="date" value={form.date} onChange={(e) => set("date", e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="appt-time">Start</Label>
              <Input id="appt-time" type="time" value={form.time} onChange={(e) => set("time", e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label>Length</Label>
              <Select value={String(form.duration)} onValueChange={(v) => set("duration", Number(v))}>
                <SelectTrigger aria-label="Length"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Array.from(new Set([...DURATIONS, form.duration])).sort((a, b) => a - b).map((d) => (
                    <SelectItem key={d} value={String(d)}>{d < 60 ? `${d} min` : `${d / 60} hr`}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Agent</Label>
            {onlySelf ? (
              <p className="rounded-md border border-input bg-muted/40 px-3 py-2 text-sm">You ({agentList[0].firstName} {agentList[0].lastName})</p>
            ) : (
              <Select value={form.agentId || "none"} onValueChange={(v) => set("agentId", v === "none" ? "" : v)}>
                <SelectTrigger aria-label="Agent"><SelectValue placeholder="Unassigned" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Unassigned</SelectItem>
                  {agentList.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.firstName} {a.lastName}{a.isMe ? " (you)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Where</Label>
              <Select value={form.locationType} onValueChange={(v) => set("locationType", v as LocationType)}>
                <SelectTrigger aria-label="Location"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {LOCATION_TYPES.map((l) => (
                    <SelectItem key={l} value={l}>{LOCATION_LABELS[l]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {form.locationType === "video" ? (
              <div className="space-y-1.5">
                <Label htmlFor="appt-url">Meeting link</Label>
                <Input id="appt-url" type="url" placeholder="https://" value={form.meetingUrl} onChange={(e) => set("meetingUrl", e.target.value)} />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="appt-loc">Details</Label>
                <Input
                  id="appt-loc"
                  maxLength={300}
                  placeholder={form.locationType === "phone" ? "Who calls whom" : "Address or room"}
                  value={form.locationDetail}
                  onChange={(e) => set("locationDetail", e.target.value)}
                />
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="appt-notes" className="flex items-center gap-1.5">
              Notes <Lock className="h-3 w-3 text-muted-foreground" />
            </Label>
            {appointment?.notesMasked ? (
              <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                Notes are hidden for your role because they may contain health details.
              </p>
            ) : (
              <Textarea
                id="appt-notes"
                rows={3}
                maxLength={4000}
                value={form.notes}
                onChange={(e) => set("notes", e.target.value)}
                placeholder="Anything to prepare"
              />
            )}
            <p className="text-xs text-muted-foreground">Stored encrypted. Only admins, compliance and the assigned agent can read them.</p>
          </div>

          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

          <DialogFooter className="gap-2 sm:justify-between">
            {editing && canDelete ? (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                disabled={remove.isPending}
                onClick={() => {
                  if (window.confirm("Delete this appointment? This cannot be undone.")) remove.mutate();
                }}
              >
                <Trash2 className="mr-1.5 h-4 w-4" /> Delete
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? "Saving…" : editing ? "Save changes" : "Book appointment"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
