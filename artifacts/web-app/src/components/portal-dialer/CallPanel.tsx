/**
 * Softphone in-call surface: status, mute, hang up, live timer, and the
 * post-call disposition + notes form. Everything shown is real call state —
 * no simulated timers or transcripts.
 */
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ClipboardList, Loader2, Mic, MicOff, PhoneCall, PhoneOff, ShieldX, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SectionCard } from "@/components/shared";
import { ComingSoonNote } from "@/components/portal-dialer";
import { cn } from "@/lib/utils";
import { RECENT_CALLS_KEY, contactActivitiesKey, useDispositions } from "@/lib/portalDialer/api";
import {
  formatElapsed,
  saveCallDisposition,
  type CallState,
  type VoiceReadiness,
} from "@/lib/portalDialer/calling";

/** Header pill: the honest state of browser calling. */
export function CallingStatusBadge({ readiness }: { readiness: VoiceReadiness }) {
  const map = {
    checking: { dot: "bg-muted-foreground/50", text: "Browser calling: checking…" },
    ready: { dot: "bg-success", text: "Browser calling: ready" },
    needs_setup: { dot: "bg-warning", text: "Browser calling: needs setup" },
    demo: { dot: "bg-muted-foreground/50", text: "Browser calling: off in the demo" },
    error: { dot: "bg-destructive", text: "Browser calling: unavailable" },
  } as const;
  const m = map[readiness.state];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
      <span className={cn("h-2 w-2 rounded-full", m.dot)} /> {m.text}
    </span>
  );
}

/** Why calling is off, in words an owner can act on. Renders nothing when ready. */
export function CallingSetupNote({ readiness, showNames }: { readiness: VoiceReadiness; showNames: boolean }) {
  if (readiness.state === "demo") {
    return (
      <ComingSoonNote title="This is a demo — calls are turned off" icon={PhoneCall}>
        You can look people up and check whether it's OK to call them, but no real call is ever placed from a demo.
      </ComingSoonNote>
    );
  }
  if (readiness.state === "needs_setup") {
    return (
      <ComingSoonNote title="Needs setup" tone="setup" icon={PhoneCall}>
        Browser calling isn't switched on for this agency yet.{" "}
        {showNames && readiness.missing.length > 0
          ? `Still missing: ${readiness.missing.join(", ")}. `
          : "Ask your agency administrator to finish the Twilio setup. "}
        Until then, place the call from your own phone and log it below.
      </ComingSoonNote>
    );
  }
  if (readiness.state === "error") {
    return (
      <ComingSoonNote title="Couldn't check calling setup" tone="setup" icon={TriangleAlert}>
        {readiness.message}
      </ComingSoonNote>
    );
  }
  return null;
}

function Timer({ since }: { since: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since == null) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [since]);
  return (
    <span className="font-mono text-2xl font-semibold tabular-nums" aria-label="Call timer">
      {since == null ? "00:00" : formatElapsed(now - since)}
    </span>
  );
}

function PostCallForm({
  callSessionId,
  contactId,
  answered,
  onDone,
}: {
  callSessionId: string;
  contactId: string | null;
  /** DO_NOT_CALL is only offered for a call the other party actually answered. */
  answered: boolean;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const { data: dispositions } = useDispositions();
  const [disposition, setDisposition] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!disposition && !notes.trim()) return;
    setSaving(true);
    try {
      await saveCallDisposition(callSessionId, {
        ...(disposition ? { dispositionCode: disposition } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      toast.success(disposition === "DO_NOT_CALL" ? "Saved — this number is now on the do-not-call list" : "Call saved");
      void qc.invalidateQueries({ queryKey: RECENT_CALLS_KEY });
      if (contactId) void qc.invalidateQueries({ queryKey: contactActivitiesKey(contactId) });
      onDone();
    } catch (err) {
      toast.error((err as Error).message || "Couldn't save the call");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <div className="space-y-1.5">
        <Label htmlFor="postcall-disposition">How did it go?</Label>
        <Select value={disposition} onValueChange={setDisposition}>
          <SelectTrigger id="postcall-disposition"><SelectValue placeholder="Choose an outcome" /></SelectTrigger>
          <SelectContent>
            {(dispositions?.data ?? []).filter((d) => answered || d.code !== "DO_NOT_CALL").map((d) => (
              <SelectItem key={d.code} value={d.code}>{d.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {disposition === "DO_NOT_CALL" && (
          <p className="text-xs text-destructive">
            Saving this puts the number on the do-not-call list — no one at your agency will be able to call or text it.
          </p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="postcall-notes">Notes</Label>
        <Textarea
          id="postcall-notes"
          rows={4}
          maxLength={2000}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="What was discussed, next steps…"
        />
      </div>
      <div className="flex gap-2">
        <Button className="flex-1" onClick={save} disabled={saving || (!disposition && !notes.trim())}>
          {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <ClipboardList className="mr-1.5 h-4 w-4" />}
          Save call
        </Button>
        <Button variant="outline" onClick={onDone} disabled={saving}>Skip</Button>
      </div>
    </div>
  );
}

export function CallPanel({
  state,
  onHangUp,
  onToggleMute,
  onDone,
}: {
  state: CallState;
  onHangUp: () => void;
  onToggleMute: () => void;
  onDone: () => void;
}) {
  // The name captured when Call was pressed — the picker may move on mid-call.
  const contactName = state.contactName ?? "this contact";
  const live = state.phase === "checking" || state.phase === "connecting" || state.phase === "ringing" || state.phase === "in_call";
  const label =
    state.phase === "checking" ? "Checking it's OK to call…"
    : state.phase === "connecting" ? "Connecting…"
    : state.phase === "ringing" ? "Ringing…"
    : state.phase === "in_call" ? "In call"
    : "Call ended";

  if (state.blocked) {
    return (
      <SectionCard title="Call blocked" icon={ShieldX} className="ring-1 ring-destructive/40">
        <p className="mb-2 text-sm">
          We didn't place the call to <span className="font-semibold">{contactName}</span>:
        </p>
        <ul className="space-y-1.5" aria-label="Reasons the call was blocked">
          {state.blocked.map((r, i) => (
            <li key={`${r.code}-${i}`} className="flex items-start gap-2 rounded-lg bg-destructive/5 px-3 py-2 text-sm">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <span>{r.detail}</span>
            </li>
          ))}
        </ul>
        <Button variant="outline" size="sm" className="mt-3" onClick={onDone}>Dismiss</Button>
      </SectionCard>
    );
  }

  if (state.phase === "idle") {
    if (state.unavailable) {
      return (
        <ComingSoonNote title={state.unavailable === "demo" ? "Calls are turned off in the demo" : "Needs setup"} tone="setup" icon={PhoneCall}>
          {state.unavailable === "demo"
            ? "No real call is ever placed from a demo."
            : "Browser calling isn't switched on for this agency yet."}
        </ComingSoonNote>
      );
    }
    if (state.error) {
      return (
        <ComingSoonNote title="The call didn't start" tone="setup" icon={TriangleAlert}>
          {state.error}
        </ComingSoonNote>
      );
    }
    return null;
  }

  return (
    <SectionCard title={live ? "Live call" : "After the call"} icon={PhoneCall} className={cn(live && "ring-1 ring-success/40")}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-display font-semibold">{contactName}</p>
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground" role="status">
            {live && state.phase !== "in_call" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {label}
          </p>
        </div>
        {state.phase === "in_call" && <Timer since={state.answeredAt} />}
        {state.phase === "ended" && state.answeredAt != null && state.endedAt != null && (
          <span className="font-mono text-2xl font-semibold tabular-nums" aria-label="Call length">
            {formatElapsed(state.endedAt - state.answeredAt)}
          </span>
        )}
      </div>

      {state.consentBasis === "imported_ghl_recorded_call" && (
        <p
          className="mt-3 flex items-start gap-2 rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground"
          data-testid="imported-consent-note"
        >
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Allowed on the imported-client basis: this contact came from GoHighLevel and has no do-not-contact flag.
            Consent is not documented in agencyBRIDGE, and the national and state do-not-call registries were not checked.
          </span>
        </p>
      )}

      {state.error && (
        <p className="mt-3 flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-sm" role="alert">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          {state.error}
        </p>
      )}

      {live && (
        <div className="mt-4 grid grid-cols-2 gap-2">
          <Button variant="outline" onClick={onToggleMute} disabled={state.phase !== "in_call"} aria-pressed={state.muted}>
            {state.muted ? <MicOff className="mr-1.5 h-4 w-4" /> : <Mic className="mr-1.5 h-4 w-4" />}
            {state.muted ? "Unmute" : "Mute"}
          </Button>
          <Button variant="destructive" onClick={onHangUp} disabled={state.phase === "checking"}>
            <PhoneOff className="mr-1.5 h-4 w-4" /> Hang up
          </Button>
        </div>
      )}

      {state.phase === "ended" && state.callSessionId && (
        <div className="mt-4">
          <PostCallForm
            callSessionId={state.callSessionId}
            contactId={state.contactId}
            answered={state.answered}
            onDone={onDone}
          />
        </div>
      )}
    </SectionCard>
  );
}
