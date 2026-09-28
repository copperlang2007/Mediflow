import { Link } from "wouter";
import { ArrowLeft, Ban, CheckCircle2, Eye, Mail, MessageSquare, MousePointerClick, Send, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, MiniStat, SectionCard, StatusPill } from "@/components/shared";
import { describeAudience, fmtDate, useCampaignDetail } from "./api";

const CAMPAIGN_TONE = {
  draft: "neutral",
  scheduled: "navy",
  sending: "warning",
  sent: "success",
  cancelled: "danger",
} as const;

const RECIPIENT_LABEL: Record<string, string> = {
  queued: "Waiting",
  sent: "Sent",
  delivered: "Delivered",
  bounced: "Bounced",
  failed: "Failed",
  skipped_opt_out: "Skipped — opted out",
};

function recipientTone(s: string) {
  if (s === "delivered" || s === "sent") return "success" as const;
  if (s === "bounced" || s === "failed") return "danger" as const;
  if (s === "skipped_opt_out") return "neutral" as const;
  return "warning" as const;
}

export function CampaignDetail({
  id,
  onBack,
  trackingConnected,
}: {
  id: string;
  onBack: () => void;
  trackingConnected: boolean;
}) {
  const { data: c, isLoading } = useCampaignDetail(id);
  if (isLoading || !c) return <Skeleton className="h-96 rounded-xl" />;
  const Icon = c.channel === "email" ? Mail : MessageSquare;
  const rate = (n: number) => (trackingConnected && c.sentCount > 0 ? `${((n / c.sentCount) * 100).toFixed(1)}%` : "—");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 mr-1.5" />All campaigns
        </Button>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-navy-100 text-navy-800 dark:bg-secondary dark:text-secondary-foreground">
            <Icon className="h-6 w-6" />
          </div>
          <div>
            <h2 className="font-display text-xl font-bold">{c.name}</h2>
            <p className="text-sm text-muted-foreground">
              {c.templateName ?? "Custom message"} · {describeAudience(c.audience)}
            </p>
          </div>
        </div>
        <StatusPill tone={CAMPAIGN_TONE[c.status]} className="lowercase">{c.status}</StatusPill>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <MiniStat icon={Send} label="Sent" value={c.sentCount} />
        <MiniStat icon={CheckCircle2} label="Delivered" value={trackingConnected ? c.deliveredCount : "—"} tone="success" />
        {c.channel === "email" ? (
          <>
            <MiniStat icon={Eye} label="Open rate" value={rate(c.openedCount)} />
            <MiniStat icon={MousePointerClick} label="Click rate" value={rate(c.clickedCount)} />
          </>
        ) : (
          <MiniStat icon={XCircle} label="Failed" value={c.failedCount} tone={c.failedCount ? "danger" : "default"} />
        )}
        <MiniStat icon={Ban} label="Skipped (opted out)" value={c.skippedCount} tone="warning" />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <SectionCard title="Message" className="lg:col-span-1">
          <dl className="space-y-2 text-sm">
            {c.channel === "email" && (
              <div>
                <dt className="text-xs text-muted-foreground">Subject</dt>
                <dd className="font-medium">{c.subject ?? "From template"}</dd>
              </div>
            )}
            <div>
              <dt className="text-xs text-muted-foreground">Body</dt>
              <dd className="whitespace-pre-wrap break-words text-muted-foreground line-clamp-[12]">
                {c.body ? c.body.replace(/<[^>]+>/g, " ").replace(/\s+\n/g, "\n").trim() : "From template"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{c.status === "scheduled" ? "Scheduled for" : "Sent"}</dt>
              <dd>{fmtDate(c.status === "scheduled" ? c.scheduledAt : (c.sentAt ?? c.startedAt), true)}</dd>
            </div>
          </dl>
        </SectionCard>
        <SectionCard title="Recipients" description="Who this went to — each name links to the client's record and timeline" className="lg:col-span-2">
          {c.recipients.length === 0 ? (
            <EmptyState compact title="No recipients yet" description="Recipients are picked from the audience when the campaign starts sending." />
          ) : (
            <ul className="max-h-[28rem] divide-y divide-border overflow-y-auto">
              {c.recipients.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <div className="min-w-0">
                    <Link href={`/crm/contacts/${r.contactId}`} className="font-medium hover:underline">
                      {r.firstName} {r.lastName}
                    </Link>
                    {r.error && r.status !== "skipped_opt_out" && <p className="text-xs text-destructive truncate">{r.error}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {r.openedAt && <Eye className="h-3.5 w-3.5 text-accent" aria-label="Opened" />}
                    {r.clickedAt && <MousePointerClick className="h-3.5 w-3.5 text-accent" aria-label="Clicked" />}
                    {r.unsubscribedAt && <Ban className="h-3.5 w-3.5 text-destructive" aria-label="Unsubscribed" />}
                    <StatusPill tone={recipientTone(r.status)}>{RECIPIENT_LABEL[r.status] ?? r.status}</StatusPill>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
