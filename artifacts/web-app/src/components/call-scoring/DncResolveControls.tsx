/**
 * One-click confirm / dismiss for a possible do-not-contact request.
 *
 * Nothing is added to the do-not-contact list until a person presses
 * "Add to do-not-contact list". If the server needs more (several clients share
 * the number, or there is no phone on file) it says so and this asks for it.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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

export function DncResolveControls({
  findingId,
  contact,
  candidates = [],
  onDone,
}: {
  findingId: string;
  contact: { id: string; name: string } | null;
  candidates?: Candidate[];
  onDone?: () => void;
}) {
  const qc = useQueryClient();
  const [pool, setPool] = useState<Candidate[]>(candidates);
  const [pickedId, setPickedId] = useState<string>("");
  const [needPhone, setNeedPhone] = useState(false);
  const [phone, setPhone] = useState("");
  const [dismissing, setDismissing] = useState(false);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const mustPick = !contact && pool.length > 0;

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
        setNeedPhone(true);
        setProblem("There is no phone number on file for this call. Type the number to add.");
      } else {
        setProblem(apiMessage(err, "That did not work. Nothing was changed."));
      }
    },
  });

  const confirm = () =>
    resolve.mutate({
      action: "add_opt_out",
      ...(pickedId ? { contactId: pickedId } : {}),
      ...(needPhone && phone.trim() ? { phone: phone.trim() } : {}),
    });

  return (
    <div className="space-y-3">
      {mustPick && (
        <fieldset className="space-y-1.5">
          <legend className="text-xs font-medium text-muted-foreground">Which client is this?</legend>
          {pool.map((c) => (
            <label key={c.id} className="flex items-center gap-2 text-sm">
              <input type="radio" name={`pick-${findingId}`} value={c.id} checked={pickedId === c.id} onChange={() => setPickedId(c.id)} />
              <span>
                {c.name}
                {c.phoneLast4 ? <span className="text-muted-foreground"> · phone ends {c.phoneLast4}</span> : null}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {needPhone && (
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
          <Button size="sm" onClick={confirm} disabled={resolve.isPending || (mustPick && !pickedId)}>
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
