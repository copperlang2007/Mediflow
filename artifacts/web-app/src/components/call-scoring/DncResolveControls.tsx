/**
 * One-click confirm / dismiss for a possible do-not-contact request.
 *
 * Nothing is added to the do-not-contact list until a person presses
 * "Add to do-not-contact list", and only for the ONE number the reviewer
 * confirms asked for no contact. If several clients share the number (or more
 * than can be listed), the reviewer picks or searches for the right client.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { PhoneOff, X } from "lucide-react";
import { QK, apiData, apiMessage } from "./shared";

interface Candidate {
  id: string;
  name: string;
  phoneLast4: string | null;
}

export interface NumberOption {
  source: "transcript" | "contact";
  last4: string | null;
}

type Choice = "transcript" | "contact" | "typed" | "";

interface SearchContact {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
}

const last4Of = (phone: string | null | undefined) => {
  const d = (phone ?? "").replace(/\D/g, "");
  return d.length >= 4 ? d.slice(-4) : null;
};

export function DncResolveControls({
  findingId,
  contact,
  candidates = [],
  moreCandidates = false,
  numbers = [],
  onDone,
}: {
  findingId: string;
  contact: { id: string; name: string } | null;
  candidates?: Candidate[];
  moreCandidates?: boolean;
  numbers?: NumberOption[];
  onDone?: () => void;
}) {
  const qc = useQueryClient();
  const [pool, setPool] = useState<Candidate[]>(candidates);
  const [pickedId, setPickedId] = useState<string>("");
  const [pickedLast4, setPickedLast4] = useState<string | null>(null);
  const [choice, setChoice] = useState<Choice>("");
  const [phone, setPhone] = useState("");
  const [dismissing, setDismissing] = useState(false);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const mustPick = !contact && pool.length > 0;
  const canSearch = !contact && (pool.length > 0 || moreCandidates);

  const { data: found } = useQuery({
    queryKey: [...QK, "contact-search", debounced],
    enabled: canSearch && debounced.length >= 2,
    staleTime: 15_000,
    queryFn: () => customFetch<{ data: SearchContact[] }>(`/api/contacts?search=${encodeURIComponent(debounced)}&limit=8`),
  });
  const searchHits: Candidate[] = (found?.data ?? []).map((c) => ({
    id: c.id,
    name: `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || "Unnamed contact",
    phoneLast4: last4Of(c.phone),
  }));

  // The numbers the reviewer may confirm: the ones on file, plus the picked client's, plus "type one".
  const options: Array<{ value: Exclude<Choice, "">; label: string }> = [];
  for (const n of numbers) {
    options.push({
      value: n.source,
      label: `Number ending ${n.last4 ?? "????"} (${n.source === "transcript" ? "given with this call" : "on the client's record"})`,
    });
  }
  if (pickedId && pickedLast4 && !options.some((o) => o.value === "contact")) {
    options.push({ value: "contact", label: `Number ending ${pickedLast4} (on the picked client's record)` });
  }
  options.push({ value: "typed", label: "A different number (type it)" });

  const resolve = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      customFetch<{ status: string; action: string }>(`/api/call-scoring/dnc-review/${findingId}/resolve`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (res, body) => {
      const added = body["action"] === "add_opt_out";
      toast.success(
        res.status === "already_resolved"
          ? "This request was already handled."
          : added
            ? "Added to the do-not-contact list."
            : "Dismissed. Nothing was added.",
      );
      setProblem(null);
      void qc.invalidateQueries({ queryKey: QK });
      onDone?.();
    },
    onError: (err) => {
      const data = apiData<{ candidates?: Candidate[] }>(err);
      if (data?.code === "pick_contact" && data.candidates) {
        setPool(data.candidates);
        setProblem("More than one client uses this number. Pick the right one, then confirm.");
      } else if (data?.code === "phone_required") {
        setProblem(apiMessage(err, "Confirm the number that asked for no contact."));
      } else {
        setProblem(apiMessage(err, "That did not work. Nothing was changed."));
      }
    },
  });

  const needsTyped = choice === "typed";
  const confirmReady = choice !== "" && (!needsTyped || phone.replace(/\D/g, "").length >= 7) && !(mustPick && !pickedId);

  const confirm = () =>
    resolve.mutate({
      action: "add_opt_out",
      phoneSource: choice,
      ...(pickedId ? { contactId: pickedId } : {}),
      ...(needsTyped ? { phone: phone.trim() } : {}),
    });

  const pick = (c: Candidate) => {
    setPickedId(c.id);
    setPickedLast4(c.phoneLast4);
  };

  return (
    <div className="space-y-3">
      {mustPick && (
        <fieldset className="space-y-1.5">
          <legend className="text-xs font-medium text-muted-foreground">Which client is this?</legend>
          {pool.map((c) => (
            <label key={c.id} className="flex items-center gap-2 text-sm">
              <input type="radio" name={`pick-${findingId}`} value={c.id} checked={pickedId === c.id} onChange={() => pick(c)} />
              <span>
                {c.name}
                {c.phoneLast4 ? <span className="text-muted-foreground"> · phone ends {c.phoneLast4}</span> : null}
              </span>
            </label>
          ))}
          {moreCandidates && <p className="text-xs text-muted-foreground">More clients share this number than are listed. Search to narrow it down.</p>}
        </fieldset>
      )}
      {canSearch && (
        <div className="space-y-1">
          <Label htmlFor={`search-${findingId}`} className="text-xs">Search for the client</Label>
          <Input
            id={`search-${findingId}`}
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name, email or phone"
            className="max-w-xs"
          />
          {debounced.length >= 2 && (
            <ul className="space-y-1" aria-label="Search results">
              {searchHits.length === 0 ? (
                <li className="text-xs text-muted-foreground">No clients found.</li>
              ) : (
                searchHits.map((c) => (
                  <li key={c.id}>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="radio" name={`pick-${findingId}`} value={c.id} checked={pickedId === c.id} onChange={() => pick(c)} />
                      <span>
                        {c.name}
                        {c.phoneLast4 ? <span className="text-muted-foreground"> · phone ends {c.phoneLast4}</span> : null}
                      </span>
                    </label>
                  </li>
                ))
              )}
            </ul>
          )}
        </div>
      )}
      {!dismissing && (
        <fieldset className="space-y-1.5">
          <legend className="text-xs font-medium text-muted-foreground">Which number asked to stop? Only this number is added.</legend>
          {options.map((o) => (
            <label key={o.value} className="flex items-center gap-2 text-sm">
              <input type="radio" name={`number-${findingId}`} value={o.value} checked={choice === o.value} onChange={() => setChoice(o.value)} />
              <span>{o.label}</span>
            </label>
          ))}
        </fieldset>
      )}
      {needsTyped && !dismissing && (
        <div className="space-y-1">
          <Label htmlFor={`phone-${findingId}`} className="text-xs">Phone number to add</Label>
          <Input id={`phone-${findingId}`} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(310) 555-0100" className="max-w-xs" />
        </div>
      )}
      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      {dismissing && (
        <div className="space-y-1">
          <Label htmlFor={`note-${findingId}`} className="text-xs">Why is this not a request? (required)</Label>
          <Textarea id={`note-${findingId}`} value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {!dismissing && (
          <Button size="sm" onClick={confirm} disabled={resolve.isPending || !confirmReady}>
            <PhoneOff className="mr-1.5 h-3.5 w-3.5" />
            Add to do-not-contact list
          </Button>
        )}
        {dismissing ? (
          <>
            <Button size="sm" variant="secondary" onClick={() => resolve.mutate({ action: "dismiss", note: note.trim() })} disabled={resolve.isPending || note.trim().length < 3}>
              Save dismissal
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDismissing(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setDismissing(true)} disabled={resolve.isPending}>
            <X className="mr-1.5 h-3.5 w-3.5" />
            Not a request
          </Button>
        )}
        {contact && !dismissing && <span className="text-xs text-muted-foreground">Client: {contact.name}</span>}
      </div>
    </div>
  );
}
