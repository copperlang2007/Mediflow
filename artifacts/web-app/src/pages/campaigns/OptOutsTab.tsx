import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Ban, Info, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState, SectionCard } from "@/components/shared";
import { toast } from "sonner";
import { type Channel, type OptOutItem, QK, errorMessage, fmtDate, jsonInit, useOptOuts } from "./api";

function ResubscribeDialog({ item, onClose }: { item: OptOutItem | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [confirmed, setConfirmed] = useState(false);
  const [reason, setReason] = useState("");
  const m = useMutation({
    mutationFn: () =>
      customFetch(`/api/campaigns/opt-outs/email/resubscribe`, jsonInit("POST", { contactId: item!.contactId, confirm: true, reason })),
    onSuccess: () => {
      toast.success("Email re-subscribed and recorded in the audit log");
      void qc.invalidateQueries({ queryKey: QK.all });
      setConfirmed(false);
      setReason("");
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e, "Could not re-subscribe")),
  });
  return (
    <Dialog open={!!item} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display">Re-subscribe {item?.name ?? item?.address} to email?</DialogTitle>
          <DialogDescription>
            Only do this if the client has asked to receive your emails again. Your name, the time and the reason are saved in the audit log.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="resub-reason">How did they ask? (required)</Label>
            <Textarea
              id="resub-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Client emailed on 3/1 asking to get newsletters again"
            />
          </div>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={confirmed} onCheckedChange={(v) => setConfirmed(v === true)} aria-label="Confirm client consent" />
            <span>I confirm the client asked to be re-subscribed to marketing email.</span>
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={() => m.mutate()} disabled={!confirmed || reason.trim().length < 5 || m.isPending}>
              Re-subscribe
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function OptOutsTab({ channel, canManage }: { channel: Channel; canManage: boolean }) {
  const { data, isLoading } = useOptOuts(channel);
  const [target, setTarget] = useState<OptOutItem | null>(null);
  const items = data?.items ?? [];

  return (
    <div className="space-y-4">
      <SectionCard
        title={channel === "sms" ? `SMS opt-out list (${data?.total ?? 0})` : `Unsubscribe list (${data?.total ?? 0})`}
        description={
          channel === "sms"
            ? "Clients who replied STOP. They are left out of every text campaign automatically."
            : "Clients who unsubscribed or marked an email as spam. They are left out of every email campaign automatically."
        }
        icon={Ban}
        iconClassName="text-destructive"
      >
        {channel === "sms" && (
          <div className="mb-4 flex gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
            <Info className="h-4 w-4 mt-0.5 shrink-0 text-accent" />
            <p>
              For your protection under the TCPA, a text opt-out can't be undone here. The client can re-subscribe themselves by texting <span className="font-semibold text-foreground">START</span> to your number.
            </p>
          </div>
        )}
        {isLoading ? (
          <Skeleton className="h-24" />
        ) : items.length === 0 ? (
          <EmptyState compact icon={ShieldCheck} title={channel === "sms" ? "No SMS opt-outs" : "No unsubscribes"} description="Nobody has opted out yet." />
        ) : (
          <ul className="divide-y divide-border">
            {items.map((o, i) => (
              <li key={`${o.contactId ?? o.address}-${i}`} className="flex items-center justify-between gap-3 px-1 py-2.5 text-sm">
                <div className="flex min-w-0 items-center gap-3">
                  <Ban className="h-4 w-4 shrink-0 text-destructive" />
                  <div className="min-w-0">
                    <p className="font-medium truncate">{o.name ?? o.address ?? "Unknown"}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {o.name && o.address ? `${o.address} · ` : ""}
                      {o.source} · {fmtDate(o.optedOutAt)}
                    </p>
                  </div>
                </div>
                {channel === "email" && canManage && o.contactId && (
                  <Button variant="outline" size="sm" onClick={() => setTarget(o)}>Re-subscribe</Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
      <ResubscribeDialog item={target} onClose={() => setTarget(null)} />
    </div>
  );
}
