import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  customFetch,
  getGetEmailTemplatesQueryKey,
  getGetSmsTemplatesQueryKey,
  useGetEmailTemplates,
  useGetSmsTemplates,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Ban, CalendarClock, Mail, MessageSquare, Send, Users, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  type Audience,
  type AudiencePreview,
  type Campaign,
  type CampaignConfig,
  type Channel,
  MONTHS,
  PLAN_LABELS,
  QK,
  STATUS_LABELS,
  errorMessage,
  jsonInit,
  smsSegments,
  useAudienceOptions,
} from "./api";

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "border-navy-700 bg-navy-700 text-white dark:border-accent dark:bg-accent dark:text-accent-foreground"
          : "border-border bg-card text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function toggle(list: string[] | undefined, v: string): string[] | undefined {
  const cur = list ?? [];
  const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
  return next.length ? next : undefined;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function AudienceBuilder({
  channel,
  audience,
  onChange,
  enabled,
}: {
  channel: Channel;
  audience: Audience;
  onChange: (a: Audience) => void;
  enabled: boolean;
}) {
  const { data: options } = useAudienceOptions(enabled);
  const debounced = useDebounced(audience, 350);
  const preview = useQuery({
    queryKey: ["campaigns", "preview", channel, debounced],
    queryFn: () =>
      customFetch<AudiencePreview>("/api/campaigns/audience/preview", jsonInit("POST", { channel, audience: debounced })),
    enabled,
  });

  const row = (label: string, children: React.ReactNode) => (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-muted/40 p-4 flex items-center gap-4" aria-live="polite">
        <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-navy-100 text-navy-800 dark:bg-secondary dark:text-secondary-foreground">
          <Users className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <p className="font-display text-2xl font-bold leading-none">
            {preview.data ? preview.data.eligible.toLocaleString() : "…"}
            <span className="ml-2 text-sm font-normal text-muted-foreground">will receive this</span>
          </p>
          {preview.data && (
            <p className="mt-1 text-xs text-muted-foreground">
              {preview.data.optedOut > 0 && (
                <span className="inline-flex items-center gap-1 mr-3">
                  <Ban className="h-3 w-3" />
                  {preview.data.optedOut} opted out (skipped)
                </span>
              )}
              {preview.data.missingAddress > 0 && (
                <span>
                  {preview.data.missingAddress} without {channel === "email" ? "an email address" : "a mobile number"}
                </span>
              )}
              {preview.data.optedOut === 0 && preview.data.missingAddress === 0 && "Everyone matching can be reached."}
            </p>
          )}
        </div>
      </div>

      {row(
        "Client status",
        Object.entries(STATUS_LABELS).map(([k, label]) => (
          <Chip key={k} active={!!audience.statuses?.includes(k)} onClick={() => onChange({ ...audience, statuses: toggle(audience.statuses, k) })}>
            {label}
          </Chip>
        )),
      )}
      {row(
        "Plan type",
        Object.entries(PLAN_LABELS).map(([k, label]) => (
          <Chip key={k} active={!!audience.planTypes?.includes(k)} onClick={() => onChange({ ...audience, planTypes: toggle(audience.planTypes, k) })}>
            {label}
          </Chip>
        )),
      )}
      {!!options?.carriers.length &&
        row(
          "Carrier",
          options.carriers.map((c) => (
            <Chip key={c.id} active={!!audience.carrierIds?.includes(c.id)} onClick={() => onChange({ ...audience, carrierIds: toggle(audience.carrierIds, c.id) })}>
              {c.name}
            </Chip>
          )),
        )}
      {!!options?.states.length &&
        row(
          "State",
          options.states.map((s) => (
            <Chip key={s} active={!!audience.states?.includes(s)} onClick={() => onChange({ ...audience, states: toggle(audience.states, s) })}>
              {s}
            </Chip>
          )),
        )}
      {!!options?.sources.length &&
        row(
          "Lead source",
          options.sources.map((s) => (
            <Chip key={s} active={!!audience.sources?.includes(s)} onClick={() => onChange({ ...audience, sources: toggle(audience.sources, s) })}>
              {s}
            </Chip>
          )),
        )}
      {!!options?.tags.length &&
        row(
          "Tags",
          options.tags.map((t) => (
            <Chip key={t} active={!!audience.tags?.includes(t)} onClick={() => onChange({ ...audience, tags: toggle(audience.tags, t) })}>
              #{t}
            </Chip>
          )),
        )}
      <div className="space-y-1.5 max-w-xs">
        <p className="text-xs font-medium text-muted-foreground">Birthday month</p>
        <Select
          value={audience.birthdayMonth ? String(audience.birthdayMonth) : "any"}
          onValueChange={(v) => onChange({ ...audience, birthdayMonth: v === "any" ? undefined : Number(v) })}
        >
          <SelectTrigger aria-label="Birthday month"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any month</SelectItem>
            {MONTHS.map((m, i) => (
              <SelectItem key={m} value={String(i + 1)}>{m}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

export function CampaignBuilderDialog({
  open,
  onOpenChange,
  channel,
  campaign,
  canSend,
  config,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  channel: Channel;
  campaign: Campaign | null;
  canSend: boolean;
  config: CampaignConfig | undefined;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState<string>("none");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [audience, setAudience] = useState<Audience>({});
  const [when, setWhen] = useState<"now" | "later">("now");
  const [scheduledAt, setScheduledAt] = useState("");

  const { data: emailTemplates } = useGetEmailTemplates(undefined, {
    query: { queryKey: getGetEmailTemplatesQueryKey(), enabled: open && channel === "email" },
  });
  const { data: smsTemplates } = useGetSmsTemplates(undefined, {
    query: { queryKey: getGetSmsTemplatesQueryKey(), enabled: open && channel === "sms" },
  });

  useEffect(() => {
    if (!open) return;
    setName(campaign?.name ?? "");
    setTemplateId((channel === "email" ? campaign?.emailTemplateId : campaign?.smsTemplateId) ?? "none");
    setSubject(campaign?.subject ?? "");
    setBody(campaign?.body ?? "");
    setAudience(campaign?.audience ?? {});
    setWhen("now");
    setScheduledAt("");
  }, [open, campaign, channel]);

  const chosenTemplate = useMemo(() => {
    if (templateId === "none") return null;
    return channel === "email"
      ? emailTemplates?.find((t) => t.id === templateId)
      : smsTemplates?.find((t) => t.id === templateId);
  }, [templateId, channel, emailTemplates, smsTemplates]);

  const effectiveBody = body || (chosenTemplate ? ("bodyHtml" in chosenTemplate ? chosenTemplate.bodyHtml : chosenTemplate.body) : "");
  const effectiveSubject = subject || (chosenTemplate && "subject" in chosenTemplate ? chosenTemplate.subject : "");

  const payload = () => ({
    name: name.trim(),
    templateId: templateId === "none" ? null : templateId,
    ...(channel === "email" ? { subject: subject || null } : {}),
    body: body || null,
    audience,
  });

  const save = async (): Promise<Campaign> => {
    if (campaign) {
      return customFetch<Campaign>(`/api/campaigns/${campaign.id}`, jsonInit("PATCH", payload()));
    }
    return customFetch<Campaign>("/api/campaigns", jsonInit("POST", { channel, ...payload() }));
  };

  const invalidate = () => qc.invalidateQueries({ queryKey: QK.all });

  const saveDraft = useMutation({
    mutationFn: save,
    onSuccess: () => {
      toast.success("Draft saved");
      void invalidate();
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorMessage(e, "Could not save the campaign")),
  });

  const saveAndSend = useMutation({
    mutationFn: async () => {
      const saved = await save();
      try {
        return await customFetch<Campaign>(
          `/api/campaigns/${saved.id}/send`,
          jsonInit("POST", when === "later" && scheduledAt ? { scheduledAt: new Date(scheduledAt).toISOString() } : {}),
        );
      } finally {
        void invalidate();
      }
    },
    onSuccess: (c) => {
      toast.success(c.scheduledAt && new Date(c.scheduledAt).getTime() > Date.now() + 60_000 ? "Campaign scheduled" : "Campaign is sending");
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorMessage(e, "Could not send the campaign"), { duration: 8000 }),
  });

  const busy = saveDraft.isPending || saveAndSend.isPending;
  const valid = name.trim().length > 0;
  const readyToSend = valid && !!effectiveBody.trim() && (channel === "sms" || !!effectiveSubject.trim()) && (when === "now" || !!scheduledAt);
  const segments = smsSegments(effectiveBody);
  const setupMissing =
    channel === "email"
      ? !config?.email.sendingConfigured || !config?.email.senderAddressConfigured || !config?.email.unsubscribeConfigured
      : !config?.sms.sendingConfigured;

  const ChannelIcon = channel === "email" ? Mail : MessageSquare;
  const templates = (channel === "email" ? emailTemplates : smsTemplates) ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display">
            <ChannelIcon className="h-5 w-5 text-accent" />
            {campaign ? "Edit campaign" : `New ${channel === "email" ? "email" : "text message"} campaign`}
          </DialogTitle>
          <DialogDescription>
            Pick who gets it, write the message, then send now or schedule it. People who opted out are skipped automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          <section className="space-y-3">
            <h3 className="font-display text-sm font-semibold">1. Name</h3>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. AEP 2027 kickoff" aria-label="Campaign name" />
          </section>

          <section className="space-y-3">
            <h3 className="font-display text-sm font-semibold">2. Message</h3>
            <div className="space-y-1.5">
              <Label>Start from a template (optional)</Label>
              <Select value={templateId} onValueChange={setTemplateId}>
                <SelectTrigger aria-label="Template"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No template — write it here</SelectItem>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {channel === "email" && (
              <div className="space-y-1.5">
                <Label htmlFor="camp-subject">Subject line</Label>
                <Input
                  id="camp-subject"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder={chosenTemplate && "subject" in chosenTemplate ? chosenTemplate.subject : "Your subject line"}
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="camp-body">{channel === "email" ? "Email body (HTML allowed)" : "Text message"}</Label>
              <Textarea
                id="camp-body"
                rows={channel === "email" ? 8 : 4}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                className={channel === "email" ? "font-mono text-xs" : ""}
                placeholder={chosenTemplate ? "Leave empty to use the template text" : channel === "email" ? "<p>Hi {{first_name}},</p>" : "Hi {{first_name}}, it's {{agency_name}}…"}
              />
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <span>Insert:</span>
                {(config?.mergeFields ?? []).map((f) => (
                  <button
                    key={f.token}
                    type="button"
                    className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] hover:bg-muted"
                    onClick={() => setBody((b) => `${b}${f.token}`)}
                    title={f.label}
                  >
                    {f.token}
                  </button>
                ))}
              </div>
              {channel === "sms" ? (
                <p className="text-xs text-muted-foreground">
                  {effectiveBody.length} characters · {segments} segment{segments === 1 ? "" : "s"}. "Reply STOP to opt out." is added to each client's first campaign text. Texts only go out 8am–9pm in the client's time zone.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Your agency name, mailing address and an unsubscribe link are added to the bottom of every email automatically.
                </p>
              )}
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="font-display text-sm font-semibold">3. Audience</h3>
            <AudienceBuilder channel={channel} audience={audience} onChange={setAudience} enabled={open} />
          </section>

          {canSend && (
            <section className="space-y-3">
              <h3 className="font-display text-sm font-semibold">4. When</h3>
              <div className="flex flex-wrap items-center gap-2">
                <Chip active={when === "now"} onClick={() => setWhen("now")}>Send now</Chip>
                <Chip active={when === "later"} onClick={() => setWhen("later")}>Schedule for later</Chip>
                {when === "later" && (
                  <Input
                    type="datetime-local"
                    className="w-auto"
                    value={scheduledAt}
                    onChange={(e) => setScheduledAt(e.target.value)}
                    aria-label="Send at"
                  />
                )}
              </div>
            </section>
          )}

          {setupMissing && (
            <div className="flex gap-3 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-warning" />
              <p>
                <span className="font-medium">Needs setup before sending.</span>{" "}
                You can build and save this campaign now; sending unlocks once{" "}
                {channel === "email" ? "email sending, your mailing address and unsubscribe links are" : "text messaging (Twilio) is"} set up. See the note at the top of the page.
              </p>
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
            <Button variant="outline" onClick={() => saveDraft.mutate()} disabled={!valid || busy}>Save draft</Button>
            {canSend && (
              <Button onClick={() => saveAndSend.mutate()} disabled={!readyToSend || busy}>
                {when === "later" ? <CalendarClock className="h-4 w-4 mr-1.5" /> : <Send className="h-4 w-4 mr-1.5" />}
                {when === "later" ? "Schedule" : "Send now"}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
