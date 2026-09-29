/**
 * Softphone — dial pad + lead screen-pop + browser calling.
 *
 * Nothing on this page is simulated (no fake timers, transcripts or call
 * history). With real data it:
 *   - looks a typed number up against your contacts;
 *   - shows the contact, their past call summaries and call history;
 *   - says whether it is OK to call them right now, using the same
 *     preclearance rules the dialer integration uses (consent, DNC / opt-out,
 *     calling hours in their time zone, agent licensing / AHIP / certs);
 *   - places the call from the browser over Twilio Voice. You can only call a
 *     contact on file: the server derives the number, so typing a number is
 *     only ever a way to FIND a contact. It shows "Needs setup" until Twilio is
 *     configured, and never places a call in a demo build;
 *   - after hang-up, saves a disposition + notes on the call;
 *   - still lets you log a call you made on your own phone.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { format, formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  AlertTriangle, CheckCircle2, ClipboardList, Clock, Delete, ExternalLink, FileAudio, Headphones,
  Loader2, Mic, Phone, PhoneCall, PhoneIncoming, PhoneOutgoing, Radio, ShieldCheck, ShieldX, Sparkles,
  UserRound, XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader, SectionCard, StatusPill, EmptyState } from "@/components/shared";
import { ContactPicker, NoAccess, SoonBadge } from "@/components/portal-dialer";
import { CallPanel, CallingSetupNote, CallingStatusBadge } from "@/components/portal-dialer/CallPanel";
import { CALL_CREATE_ROLES, useSoftphoneCall, useVoiceReadiness } from "@/lib/portalDialer/calling";
import { useIsAdmin } from "@/lib/auth/useIsAdmin";
import { apiRequest } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useContactCallSummaries } from "@/lib/crm/callSummaries";
import { useGetContact } from "@workspace/api-client-react";
import {
  CONTACT_READ_ROLES,
  CONTACT_UPDATE_ROLES,
  RECENT_CALLS_KEY,
  SUPERVISOR_ROLES,
  contactActivitiesKey,
  formatPhone,
  initialsOf,
  useContactCallLogs,
  useDispositions,
  usePhoneLookup,
  usePrecheck,
  useRecentCalls,
  type ContactLite,
  type Precheck,
  type PrecheckFailure,
} from "@/lib/portalDialer/api";

const KEYS: { d: string; sub?: string }[] = [
  { d: "1" }, { d: "2", sub: "ABC" }, { d: "3", sub: "DEF" },
  { d: "4", sub: "GHI" }, { d: "5", sub: "JKL" }, { d: "6", sub: "MNO" },
  { d: "7", sub: "PQRS" }, { d: "8", sub: "TUV" }, { d: "9", sub: "WXYZ" },
  { d: "*" }, { d: "0", sub: "+" }, { d: "#" },
];

const PLAN_TYPE_SHORT: Record<string, string> = { MA: "MA", MAPD: "MAPD", PDP: "PDP", supp: "Medigap", other: "Other" };

function hourLabel(h: number): string {
  const suffix = h >= 12 ? "pm" : "am";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}${suffix}`;
}

/** Plain-language reason for one failed preclearance check. */
export function describeFailure(f: PrecheckFailure, p: Pick<Precheck, "agent" | "planYear" | "callingHours">, state?: string | null): string {
  const who = p.agent?.name ?? "The agent";
  const st = state ?? "their state";
  switch (f.code) {
    case "AGENT_NOT_LICENSED": return `${who} has no active ${st} license.`;
    case "AGENT_LICENSE_EXPIRED": return `${who}'s ${st} license has expired.`;
    case "AGENT_NO_AHIP": return `${who} hasn't completed AHIP for ${p.planYear}.`;
    case "AGENT_NOT_CERTIFIED": return `${who} has no valid carrier certification for ${p.planYear}.`;
    case "NO_CONSENT": return "There's no consent on file for this contact.";
    case "DNC": return /do_not_contact/.test(f.detail) ? "This contact is marked Do not contact." : "This number is on your do-not-call / opt-out list.";
    case "OUTSIDE_CALLING_HOURS":
      return `It's ${p.callingHours.localTime ?? "outside hours"} for them — calls are allowed ${hourLabel(p.callingHours.startHour)}–${hourLabel(p.callingHours.endHour)} their time.`;
    case "TIMEZONE_UNRESOLVED": return "Their state isn't on file, so calling hours can't be checked.";
    case "MISSING_INPUT": return /phone/.test(f.detail) ? "There's no phone number on file." : "Add their state to check the agent's license.";
    default: return f.detail;
  }
}

function CheckRow({ ok, label, hint }: { ok: boolean | null; label: string; hint?: string }) {
  return (
    <li className="flex items-start gap-2.5 py-1.5 text-sm">
      {ok === null ? (
        <span className="mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 border-muted-foreground/40" aria-label="Not checked" />
      ) : ok ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-label="Passed" />
      ) : (
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-label="Failed" />
      )}
      <span>
        <span className="font-medium">{label}</span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </li>
  );
}

function OkToCallCard({ contactId, stateCode }: { contactId: string; stateCode: string | null }) {
  const { data: p, isLoading, isError } = usePrecheck(contactId);
  return (
    <SectionCard title="OK to call?" icon={ShieldCheck} contentClassName="pt-0">
      {isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : isError || !p ? (
        <p className="text-sm text-destructive">Couldn't run the call check. Try again.</p>
      ) : (
        <>
          <div
            className={cn(
              "mb-3 flex items-center gap-3 rounded-xl border px-4 py-3",
              p.okToCall ? "border-success/30 bg-success/10" : "border-destructive/25 bg-destructive/5",
            )}
          >
            {p.okToCall ? <ShieldCheck className="h-6 w-6 text-success" /> : <ShieldX className="h-6 w-6 text-destructive" />}
            <div>
              <p className={cn("font-display font-semibold", p.okToCall ? "text-success" : "text-destructive")}>
                {p.okToCall ? "OK to call" : "Don't call right now"}
              </p>
              <p className="text-xs text-muted-foreground">
                Checked {format(new Date(p.checkedAt), "h:mm a")}
                {p.callingHours.localTime && ` · ${p.callingHours.localTime} their time`}
              </p>
            </div>
          </div>
          <ul>
            <CheckRow ok={p.checks.consent} label="Consent on file" />
            <CheckRow ok={p.checks.dncClear} label="Not on do-not-call / opt-out list" />
            <CheckRow
              ok={p.checks.withinCallingHours}
              label="Within calling hours"
              hint={`${hourLabel(p.callingHours.startHour)}–${hourLabel(p.callingHours.endHour)} in ${p.callingHours.timezone?.replace("America/", "").replace("_", " ") ?? "their time zone"}`}
            />
            <CheckRow
              ok={p.checks.agentEligible}
              label="Agent licensed & certified"
              hint={
                p.agent
                  ? `${p.agent.name}${p.agent.source === "you" ? " (you)" : p.agent.source === "assigned" ? " (assigned agent)" : ""} · ${PLAN_TYPE_SHORT[p.productLine] ?? p.productLine} ${p.planYear}`
                  : "No agent to check — assign one on the contact, or link your user to an agent profile."
              }
            />
          </ul>
          {p.failures.length > 0 && (
            <div className="mt-3 space-y-1.5 rounded-lg bg-muted/60 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Why</p>
              {p.failures.map((f, i) => (
                <p key={`${f.code}-${i}`} className="flex items-start gap-2 text-sm">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                  {describeFailure(f, p, stateCode)}
                </p>
              ))}
            </div>
          )}
        </>
      )}
    </SectionCard>
  );
}

function CallSummariesCard({ contactId }: { contactId: string }) {
  const { data, isLoading } = useContactCallSummaries(contactId);
  const logs = useContactCallLogs(contactId);
  const summaries = data?.data ?? [];
  const callLogs = logs.data ?? [];
  return (
    <SectionCard title="Call history" icon={ClipboardList} contentClassName="pt-0 space-y-4">
      {isLoading || logs.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : summaries.length === 0 && callLogs.length === 0 ? (
        <EmptyState compact icon={PhoneCall} title="No calls on record" description="Logged calls and post-call summaries for this contact will show here." />
      ) : (
        <>
          {summaries.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Post-call summaries</p>
              <ul className="space-y-2">
                {summaries.slice(0, 3).map((s) => (
                  <li key={s.ticketId} className="rounded-lg border border-border p-3 text-sm">
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground">
                        {s.parsedAt ? format(new Date(s.parsedAt), "MMM d, yyyy · h:mm a") : "—"}
                      </span>
                      {s.suggestedDisposition && <StatusPill tone="info">{s.suggestedDisposition.category.replace("_", " ").toLowerCase()}</StatusPill>}
                    </div>
                    <p>{s.summary ?? "No summary text."}</p>
                    {s.actionItems.length > 0 && (
                      <ul className="mt-1.5 list-disc pl-5 text-xs text-muted-foreground">
                        {s.actionItems.slice(0, 3).map((a, i) => <li key={i}>{a}</li>)}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {callLogs.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Logged calls</p>
              <ul className="divide-y divide-border/60">
                {callLogs.map((a) => {
                  const disp = typeof a.metadata?.disposition === "string" ? a.metadata.disposition : null;
                  return (
                    <li key={a.id} className="flex items-start justify-between gap-2 py-2 text-sm">
                      <span className="min-w-0">
                        <span className="line-clamp-2">{a.body || "Call logged"}</span>
                        <span className="text-xs text-muted-foreground">{formatDistanceToNow(new Date(a.createdAt), { addSuffix: true })}</span>
                      </span>
                      {disp && <StatusPill tone="neutral">{disp.replace("_", " ").toLowerCase()}</StatusPill>}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </>
      )}
    </SectionCard>
  );
}

function LogCallCard({ contact, canLog, notesId }: { contact: ContactLite | null; canLog: boolean; notesId: string }) {
  const qc = useQueryClient();
  const { data: dispositions } = useDispositions();
  const [disposition, setDisposition] = useState<string>("");
  const [direction, setDirection] = useState<"outbound" | "inbound">("outbound");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDisposition("");
    setNotes("");
  }, [contact?.id]);

  const save = async () => {
    if (!contact || !disposition || !notes.trim()) return;
    setSaving(true);
    try {
      await apiRequest(`/api/contacts/${contact.id}/activities`, {
        method: "POST",
        body: JSON.stringify({
          type: "call_log",
          body: notes.trim(),
          metadata: { disposition, direction, source: "softphone" },
        }),
      });
      toast.success("Call logged");
      setNotes("");
      setDisposition("");
      void qc.invalidateQueries({ queryKey: RECENT_CALLS_KEY });
      void qc.invalidateQueries({ queryKey: contactActivitiesKey(contact.id) });
    } catch (err) {
      toast.error((err as Error).message || "Couldn't log the call");
    } finally {
      setSaving(false);
    }
  };

  const disabled = !contact || !canLog;
  return (
    <SectionCard title="Log a call" icon={ClipboardList} description="Record a call you made or took outside Mediflow, on your own phone" contentClassName="space-y-3">
      {!contact ? (
        <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">Look up or pick a contact first.</p>
      ) : !canLog ? (
        <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">Your role can view calls but not log them.</p>
      ) : (
        <p className="text-sm">
          For <span className="font-semibold">{contact.firstName} {contact.lastName}</span>
        </p>
      )}
      <div className="space-y-1.5">
        <Label>Direction</Label>
        <div className="grid grid-cols-2 gap-2">
          {(["outbound", "inbound"] as const).map((d) => (
            <button
              key={d}
              type="button"
              disabled={disabled}
              onClick={() => setDirection(d)}
              aria-pressed={direction === d}
              className={cn(
                "flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50",
                direction === d ? "border-accent bg-accent/10 text-accent" : "border-border hover:bg-muted",
              )}
            >
              {d === "outbound" ? <PhoneOutgoing className="h-3.5 w-3.5" /> : <PhoneIncoming className="h-3.5 w-3.5" />}
              {d === "outbound" ? "Outbound" : "Inbound"}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="call-disposition">Call disposition</Label>
        <Select value={disposition} onValueChange={setDisposition} disabled={disabled}>
          <SelectTrigger id="call-disposition"><SelectValue placeholder="Choose an outcome" /></SelectTrigger>
          <SelectContent>
            {(dispositions?.data ?? []).map((d) => (
              <SelectItem key={d.code} value={d.code}>{d.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={notesId}>Notes</Label>
        <Textarea id={notesId} rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What was discussed, next steps…" disabled={disabled} />
      </div>
      <Button className="w-full" onClick={save} disabled={disabled || saving || !disposition || !notes.trim()}>
        {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <ClipboardList className="mr-1.5 h-4 w-4" />}
        Save call log
      </Button>
    </SectionCard>
  );
}

export default function DialerPage() {
  const { role, isLoading: roleLoading } = useIsAdmin(CONTACT_READ_ROLES);
  const allowed = !!role && (CONTACT_READ_ROLES as readonly string[]).includes(role);
  const canLog = !!role && (CONTACT_UPDATE_ROLES as readonly string[]).includes(role);
  const canCall = !!role && (CALL_CREATE_ROLES as readonly string[]).includes(role);
  const isSetupAdmin = !!role && (SUPERVISOR_ROLES as readonly string[]).includes(role);

  const search = useSearch();
  const initialContactId = useMemo(() => new URLSearchParams(search).get("contact"), [search]);

  const [number, setNumber] = useState("");
  const [debouncedNumber, setDebouncedNumber] = useState("");
  const [picked, setPicked] = useState<ContactLite | null>(null);
  const [pickedId, setPickedId] = useState<string | null>(initialContactId);
  const notesId = "softphone-call-notes";
  const readiness = useVoiceReadiness(allowed && canCall);
  const softphone = useSoftphoneCall();
  const callState = softphone.state;
  // An ended call stays "active" until the agent saves or skips the post-call
  // form, so a new call can't silently discard an unsaved disposition.
  const callActive = callState.phase !== "idle";
  const callEnded = callState.phase === "ended";

  useEffect(() => {
    const t = setTimeout(() => setDebouncedNumber(number), 300);
    return () => clearTimeout(t);
  }, [number]);

  const lookup = usePhoneLookup(allowed ? debouncedNumber : "");
  const recent = useRecentCalls(allowed);
  // Contact picked by id only (recent call / deep link) — fetch full record.
  const { data: fetched } = useGetContact(pickedId ?? "", { query: { enabled: allowed && !!pickedId && picked?.id !== pickedId } as never });
  const contact: ContactLite | null =
    picked && picked.id === pickedId ? picked : pickedId && fetched ? (fetched as unknown as ContactLite) : null;

  // A single exact match pops the screen automatically.
  useEffect(() => {
    const rows = lookup.data?.data;
    if (rows && rows.length === 1) {
      setPicked(rows[0]);
      setPickedId(rows[0].id);
    }
  }, [lookup.data]);

  const choose = (c: ContactLite) => {
    setPicked(c);
    setPickedId(c.id);
    if (c.phone) setNumber(formatPhone(c.phone));
  };

  if (!roleLoading && role && !allowed) return <NoAccess what="the softphone" />;

  const digits = number.replace(/\D/g, "");
  const lookupRows = lookup.data?.data ?? [];

  // Calling needs a contact on file (the server derives the number) and a
  // ready, non-demo setup. Say why when it can't.
  const callBlockedHint =
    !canCall ? "Your role can't place calls."
    : readiness.state === "demo" ? "Calls are turned off in the demo."
    : readiness.state === "needs_setup" ? "Browser calling needs setup."
    : readiness.state === "error" ? "Browser calling is unavailable right now."
    : readiness.state === "checking" ? "Checking browser calling…"
    : !contact ? "Pick a contact on file — you can only call contacts."
    : !contact.phone ? "This contact has no phone number."
    : callEnded ? "Save or skip the last call's notes first."
    : callActive ? "A call is in progress."
    : null;
  const canPlaceCall = callBlockedHint === null;
  const placeCall = () => {
    if (contact && canPlaceCall) void softphone.start(contact.id, `${contact.firstName} ${contact.lastName}`);
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-7xl mx-auto">
      <PageHeader title="Softphone Dialer" subtitle="Look up who you're calling, check it's OK to call, call from your browser, and log the call">
        <CallingStatusBadge readiness={readiness} />
      </PageHeader>

      {canCall && <CallingSetupNote readiness={readiness} showNames={isSetupAdmin} />}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)_minmax(0,1fr)]">
        {/* Column 1 — dial pad + recent calls */}
        <div className="space-y-6">
          <SectionCard title="Dial Pad" icon={Phone}>
            <Input
              value={number}
              onChange={(e) => setNumber(e.target.value.replace(/[^\d+()\-\s*#]/g, ""))}
              placeholder="Enter number…"
              aria-label="Phone number"
              inputMode="tel"
              className="mb-3 h-11 text-center font-mono text-lg tracking-wider"
            />
            <div className="grid grid-cols-3 gap-2">
              {KEYS.map((k) => (
                <button
                  key={k.d}
                  type="button"
                  onClick={() => setNumber((n) => n + k.d)}
                  className="flex h-14 flex-col items-center justify-center rounded-xl border border-border bg-muted/40 transition-colors hover:bg-muted active:scale-[0.98]"
                  aria-label={`Digit ${k.d}`}
                >
                  <span className="font-display text-lg font-semibold leading-none">{k.d}</span>
                  {k.sub && <span className="mt-0.5 text-[9px] font-medium tracking-widest text-muted-foreground">{k.sub}</span>}
                </button>
              ))}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Button
                className="bg-success text-white hover:bg-success/90"
                disabled={!canPlaceCall}
                onClick={placeCall}
              >
                <PhoneCall className="mr-1.5 h-4 w-4" /> Call
              </Button>
              <Button variant="outline" onClick={() => setNumber((n) => n.slice(0, -1))} onDoubleClick={() => setNumber("")} disabled={!number}>
                <Delete className="mr-1.5 h-4 w-4" /> Clear
              </Button>
            </div>
            {callBlockedHint && (
              <p className="mt-2 text-center text-xs text-muted-foreground" data-testid="call-hint">{callBlockedHint}</p>
            )}
          </SectionCard>

          <SectionCard title="Recent Calls" icon={Clock} contentClassName="pt-0">
            {recent.isLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : (recent.data?.data ?? []).length === 0 ? (
              <EmptyState compact icon={PhoneCall} title="No calls logged yet" description="Calls you log here or on a contact record show up in this list." />
            ) : (
              <ul className="divide-y divide-border/60">
                {(recent.data?.data ?? []).map((r) => {
                  const disp = typeof r.metadata?.disposition === "string" ? r.metadata.disposition : null;
                  const inbound = r.metadata?.direction === "inbound";
                  return (
                    <li key={r.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setPicked(null);
                          setPickedId(r.contactId);
                          if (r.phone) setNumber(formatPhone(r.phone));
                        }}
                        className="flex w-full items-center gap-3 py-2.5 text-left hover:bg-muted/50 rounded-lg px-1"
                      >
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent">
                          {inbound ? <PhoneIncoming className="h-4 w-4" /> : <PhoneOutgoing className="h-4 w-4" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{r.firstName} {r.lastName}</span>
                          <span className="block truncate text-xs text-muted-foreground">{r.body || "Call logged"}</span>
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="block text-[11px] text-muted-foreground">{format(new Date(r.createdAt), "MMM d, h:mm a")}</span>
                          {disp && <span className="text-[10px] font-medium text-accent">{disp.replace("_", " ").toLowerCase()}</span>}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </SectionCard>
        </div>

        {/* Column 2 — live call + screen-pop */}
        <div className="space-y-6">
          <CallPanel
            state={callState}
            onHangUp={softphone.hangUp}
            onToggleMute={softphone.toggleMute}
            onDone={softphone.reset}
          />
          <SectionCard title="Caller" icon={UserRound} className={cn(contact && "ring-1 ring-success/40")}>
            {!contact ? (
              <div className="space-y-4">
                {digits.length >= 7 && (
                  lookup.isFetching ? (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Looking up {number}…</p>
                  ) : lookupRows.length > 1 ? (
                    <div>
                      <p className="mb-2 text-sm font-medium">{lookupRows.length} contacts share this number</p>
                      <ul className="space-y-1">
                        {lookupRows.map((c) => (
                          <li key={c.id}>
                            <button type="button" onClick={() => choose(c)} className="flex w-full items-center justify-between rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-muted">
                              <span>{c.firstName} {c.lastName}</span>
                              <StatusPill status={c.status} />
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : lookupRows.length === 0 && lookup.isSuccess ? (
                    <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">No contact has this number yet.</p>
                  ) : null
                )}
                <EmptyState
                  compact
                  icon={Phone}
                  title="No caller selected"
                  description="Type a number on the dial pad, pick a recent call, or search by name."
                />
                <ContactPicker onSelect={choose} placeholder="Or search by name…" />
              </div>
            ) : (
              <div>
                <div className="flex items-start gap-3">
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-navy-800 font-display text-lg font-semibold text-white">
                    {initialsOf(contact.firstName, contact.lastName)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-display text-lg font-bold leading-tight">{contact.firstName} {contact.lastName}</p>
                    <p className="font-mono text-sm text-muted-foreground">{formatPhone(contact.phone) || "No phone on file"}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      <StatusPill status={contact.status} />
                      {contact.currentPlanType && <StatusPill tone="navy">{PLAN_TYPE_SHORT[contact.currentPlanType] ?? contact.currentPlanType}</StatusPill>}
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => { setPicked(null); setPickedId(null); setNumber(""); }}>
                    Clear
                  </Button>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border pt-3 text-sm">
                  <div className="min-w-0"><span className="text-xs text-muted-foreground">Email</span><p className="truncate">{contact.email ?? "—"}</p></div>
                  <div><span className="text-xs text-muted-foreground">State · ZIP</span><p>{[contact.stateCode, contact.zipCode].filter(Boolean).join(" · ") || "—"}</p></div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/crm/contacts/${contact.id}`}>Open contact <ExternalLink className="ml-1 h-3.5 w-3.5" /></Link>
                  </Button>
                  <Button size="sm" className="bg-success text-white hover:bg-success/90" onClick={placeCall} disabled={!canPlaceCall}>
                    <PhoneCall className="mr-1.5 h-3.5 w-3.5" /> Call
                  </Button>
                </div>
              </div>
            )}
          </SectionCard>

          {contact && <OkToCallCard contactId={contact.id} stateCode={contact.stateCode} />}
          {contact && <CallSummariesCard contactId={contact.id} />}
        </div>

        {/* Column 3 — log a call + roadmap */}
        <div className="space-y-6">
          <LogCallCard contact={contact} canLog={canLog} notesId={notesId} />
          <SectionCard title="Coming next" icon={Sparkles} contentClassName="pt-0">
            <ul className="space-y-2.5 text-sm">
              {[
                { icon: Mic, t: "Live transcription", d: "Fills in record fields while you talk." },
                { icon: FileAudio, t: "Call recording", d: "Stored with the contact, with consent." },
                { icon: Radio, t: "Hold, mute and transfer", d: "Warm transfers to another agent." },
                { icon: Headphones, t: "Supervisor listen-in", d: "Whisper and barge for coaching." },
              ].map((f) => (
                <li key={f.t} className="flex items-start gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><f.icon className="h-4 w-4" /></span>
                  <span><span className="font-medium">{f.t}</span><span className="block text-xs text-muted-foreground">{f.d}</span></span>
                </li>
              ))}
            </ul>
            <div className="mt-3"><SoonBadge /></div>
          </SectionCard>
        </div>
      </div>

    </div>
  );
}
