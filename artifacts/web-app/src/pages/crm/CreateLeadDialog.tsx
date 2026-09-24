import { useState } from "react";
import type { CreateLeadBody } from "@workspace/api-client-react";
import { useCreateLead } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";

type CreateLeadDialogProps = {
  contactId: string;
  contactName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const initialForm: Omit<CreateLeadBody, "contactId"> = {
  source: null,
  sourceDetail: null,
  score: 0,
  status: "new",
};

export default function CreateLeadDialog({
  contactId,
  contactName,
  open,
  onOpenChange,
}: CreateLeadDialogProps) {
  const [form, setForm] = useState<Omit<CreateLeadBody, "contactId">>(initialForm);
  const { mutateAsync: createLead, isPending } = useCreateLead();

  const handleCreate = async () => {
    try {
      await createLead({ data: { ...form, contactId } });
      toast.success("Lead created");
      onOpenChange(false);
      setForm(initialForm);
    } catch {
      toast.error("Failed to create lead");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create lead for {contactName}</DialogTitle>
          <DialogDescription>
            Start a sales opportunity for this contact.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="contact-lead-source">Source</Label>
            <Input
              id="contact-lead-source"
              placeholder="e.g. Referral or Web form"
              value={form.source ?? ""}
              onChange={(e) =>
                setForm((f) => ({ ...f, source: e.target.value || null }))
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="contact-lead-score">Score (0–100)</Label>
            <Input
              id="contact-lead-score"
              type="number"
              min="0"
              max="100"
              value={form.score ?? 0}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  score: parseInt(e.target.value, 10) || 0,
                }))
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="contact-lead-status">Status</Label>
            <Select
              value={form.status ?? "new"}
              onValueChange={(status) => setForm((f) => ({ ...f, status }))}
            >
              <SelectTrigger id="contact-lead-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="new">New</SelectItem>
                <SelectItem value="contacted">Contacted</SelectItem>
                <SelectItem value="qualified">Qualified</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={isPending}>
            {isPending ? "Creating…" : "Create Lead"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
