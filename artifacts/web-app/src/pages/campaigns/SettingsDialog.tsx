import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { type CampaignConfig, QK, errorMessage, jsonInit } from "./api";

const ZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Puerto_Rico",
];

export function SettingsDialog({
  open,
  onOpenChange,
  config,
  canEdit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  config: CampaignConfig | undefined;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const [senderName, setSenderName] = useState("");
  const [address, setAddress] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [tz, setTz] = useState("America/New_York");

  useEffect(() => {
    if (!open || !config) return;
    setSenderName(config.settings.senderName ?? "");
    setAddress(config.settings.physicalAddress ?? "");
    setReplyTo(config.settings.replyToEmail ?? "");
    setTz(config.settings.defaultTimeZone);
  }, [open, config]);

  const save = useMutation({
    mutationFn: () =>
      customFetch<CampaignConfig>(
        "/api/campaigns/settings",
        jsonInit("PUT", {
          senderName: senderName.trim() || null,
          physicalAddress: address.trim() || null,
          replyToEmail: replyTo.trim() || null,
          defaultTimeZone: tz,
        }),
      ),
    onSuccess: () => {
      toast.success("Campaign settings saved");
      void qc.invalidateQueries({ queryKey: QK.all });
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorMessage(e, "Could not save settings")),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display">Campaign settings</DialogTitle>
          <DialogDescription>
            Printed at the bottom of every marketing email. The law (CAN-SPAM) requires a real mailing address.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="set-name">Agency name</Label>
            <Input id="set-name" value={senderName} onChange={(e) => setSenderName(e.target.value)} disabled={!canEdit} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="set-address">Mailing address</Label>
            <Textarea
              id="set-address"
              rows={3}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder={"123 Main Street, Suite 200\nAustin, TX 78701"}
              disabled={!canEdit}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="set-reply">Reply-to email (optional)</Label>
            <Input id="set-reply" type="email" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} disabled={!canEdit} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="set-tz">Default time zone (reference only; texting hours follow each client&apos;s state)</Label>
            <select
              id="set-tz"
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={tz}
              onChange={(e) => setTz(e.target.value)}
              disabled={!canEdit}
            >
              {[...new Set([tz, ...ZONES])].map((z) => (
                <option key={z} value={z}>{z.replace("_", " ")}</option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              Texts go out 8am–9pm in each client's time zone, based on the state on their record. This zone is used when no state is on file.
            </p>
          </div>
          {canEdit ? (
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={() => save.mutate()} disabled={save.isPending}>Save settings</Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Only agency admins can change these settings.</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
