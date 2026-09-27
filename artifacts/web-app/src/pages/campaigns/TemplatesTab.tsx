/**
 * Templates tab — reuses the existing email/SMS template CRUD
 * (`/api/email-templates`, `/api/sms-templates`) through the generated hooks.
 */
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetEmailTemplatesQueryKey,
  getGetSmsTemplatesQueryKey,
  useCreateEmailTemplate,
  useCreateSmsTemplate,
  useDeleteEmailTemplate,
  useDeleteSmsTemplate,
  useGetEmailTemplates,
  useGetSmsTemplates,
  useUpdateEmailTemplate,
  useUpdateSmsTemplate,
  type EmailTemplate,
  type SmsTemplate,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState, StatusPill } from "@/components/shared";
import { Edit2, FileText, Hash, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { type Channel, errorMessage, smsSegments } from "./api";

type Draft = { id?: string; name: string; category: string; subject: string; body: string };

function TemplateDialog({
  channel,
  draft,
  onClose,
}: {
  channel: Channel;
  draft: Draft | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [d, setD] = useState<Draft | null>(draft);
  useEffect(() => setD(draft), [draft]);
  const createEmail = useCreateEmailTemplate();
  const updateEmail = useUpdateEmailTemplate();
  const createSms = useCreateSmsTemplate();
  const updateSms = useUpdateSmsTemplate();
  const busy = createEmail.isPending || updateEmail.isPending || createSms.isPending || updateSms.isPending;

  const save = async () => {
    if (!d) return;
    try {
      if (channel === "email") {
        const data = { name: d.name, category: d.category || "general", subject: d.subject, bodyHtml: d.body };
        if (d.id) await updateEmail.mutateAsync({ id: d.id, data });
        else await createEmail.mutateAsync({ data });
        void qc.invalidateQueries({ queryKey: getGetEmailTemplatesQueryKey() });
      } else {
        const data = { name: d.name, category: d.category || "general", body: d.body };
        if (d.id) await updateSms.mutateAsync({ id: d.id, data });
        else await createSms.mutateAsync({ data });
        void qc.invalidateQueries({ queryKey: getGetSmsTemplatesQueryKey() });
      }
      toast.success("Template saved");
      onClose();
    } catch (e) {
      toast.error(errorMessage(e, "Could not save the template"));
    }
  };

  const valid = !!d && d.name.trim() && d.body.trim() && (channel === "sms" || d.subject.trim());
  const segments = smsSegments(d?.body ?? "");

  return (
    <Dialog open={!!draft} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display">
            {d?.id ? "Edit template" : `New ${channel === "email" ? "email" : "text message"} template`}
          </DialogTitle>
        </DialogHeader>
        {d && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="tpl-name">Template name</Label>
                <Input id="tpl-name" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tpl-cat">Category</Label>
                <Input id="tpl-cat" value={d.category} onChange={(e) => setD({ ...d, category: e.target.value })} placeholder="e.g. AEP, Retention, Welcome" />
              </div>
            </div>
            {channel === "email" && (
              <div className="space-y-1.5">
                <Label htmlFor="tpl-subject">Subject line</Label>
                <Input id="tpl-subject" value={d.subject} onChange={(e) => setD({ ...d, subject: e.target.value })} />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="tpl-body">{channel === "email" ? "Email body (HTML)" : "Message"}</Label>
              <Textarea
                id="tpl-body"
                rows={channel === "email" ? 10 : 5}
                className={channel === "email" ? "font-mono text-xs" : ""}
                value={d.body}
                onChange={(e) => setD({ ...d, body: e.target.value })}
                placeholder={channel === "email" ? "<p>Hi {{first_name}},</p>" : "Hi {{first_name}}, it's {{agency_name}}…"}
              />
              {channel === "sms" && (
                <p className="text-xs text-muted-foreground">
                  {d.body.length} characters · {segments} segment{segments === 1 ? "" : "s"}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button onClick={save} disabled={!valid || busy}>Save template</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function TemplatesTab({ channel, canEdit, canDelete }: { channel: Channel; canEdit: boolean; canDelete: boolean }) {
  const qc = useQueryClient();
  const emails = useGetEmailTemplates(undefined, {
    query: { queryKey: getGetEmailTemplatesQueryKey(), enabled: channel === "email" },
  });
  const sms = useGetSmsTemplates(undefined, {
    query: { queryKey: getGetSmsTemplatesQueryKey(), enabled: channel === "sms" },
  });
  const delEmail = useDeleteEmailTemplate();
  const delSms = useDeleteSmsTemplate();
  const [draft, setDraft] = useState<Draft | null>(null);

  const loading = channel === "email" ? emails.isLoading : sms.isLoading;
  const items: Array<EmailTemplate | SmsTemplate> = (channel === "email" ? emails.data : sms.data) ?? [];

  const remove = async (t: EmailTemplate | SmsTemplate) => {
    if (!window.confirm(`Delete the template "${t.name}"? Campaigns already sent keep their own copy.`)) return;
    try {
      if (channel === "email") {
        await delEmail.mutateAsync({ id: t.id });
        void qc.invalidateQueries({ queryKey: getGetEmailTemplatesQueryKey() });
      } else {
        await delSms.mutateAsync({ id: t.id });
        void qc.invalidateQueries({ queryKey: getGetSmsTemplatesQueryKey() });
      }
      toast.success("Template deleted");
    } catch (e) {
      toast.error(errorMessage(e, "Could not delete the template"));
    }
  };

  return (
    <div className="space-y-4">
      {canEdit && (
        <div className="flex justify-end">
          <Button onClick={() => setDraft({ name: "", category: "", subject: "", body: "" })}>
            <Plus className="h-4 w-4 mr-1.5" />New {channel === "email" ? "Email" : "SMS"} Template
          </Button>
        </div>
      )}

      {loading ? (
        <div className="grid gap-3 md:grid-cols-2">
          {[0, 1].map((i) => <Skeleton key={i} className="h-32 rounded-xl" />)}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-border bg-card shadow-sm">
          <EmptyState
            icon={FileText}
            title={`No ${channel === "email" ? "email" : "text message"} templates yet`}
            description="Save messages you send often — AEP reminders, birthday notes, welcome texts — and reuse them in campaigns and drip sequences."
            action={canEdit ? { label: "Create a template", onClick: () => setDraft({ name: "", category: "", subject: "", body: "" }) } : undefined}
          />
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {items.map((t) => {
            const body = "bodyHtml" in t ? t.bodyHtml : t.body;
            return (
              <div key={t.id} className="rounded-xl border border-border bg-card p-4 shadow-sm transition-shadow hover:shadow-md">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-display font-semibold truncate">{t.name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground line-clamp-1">
                      {"subject" in t ? t.subject : body.slice(0, 80)}
                    </p>
                  </div>
                  <StatusPill tone="navy">{t.category}</StatusPill>
                </div>
                {channel === "sms" ? (
                  <p className="mb-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Hash className="h-3.5 w-3.5" />
                    {smsSegments(body)} segment(s) · {body.length} chars
                  </p>
                ) : (
                  <p className="mb-3 text-xs text-muted-foreground line-clamp-2">{body.replace(/<[^>]+>/g, " ").trim()}</p>
                )}
                {canEdit && (
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setDraft({ id: t.id, name: t.name, category: t.category, subject: "subject" in t ? t.subject : "", body })}
                    >
                      <Edit2 className="h-3.5 w-3.5 mr-1.5" />Edit
                    </Button>
                    {canDelete && (
                      <Button variant="outline" size="sm" className="text-destructive" onClick={() => remove(t)} aria-label={`Delete ${t.name}`}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <TemplateDialog channel={channel} draft={draft} onClose={() => setDraft(null)} />
    </div>
  );
}
