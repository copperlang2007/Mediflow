import { CheckCircle2, Eye, Link2, MousePointerClick, PlugZap, Ban, AlertTriangle } from "lucide-react";
import { EmptyState, SectionCard } from "@/components/shared";
import { Skeleton } from "@/components/ui/skeleton";
import { type Campaign, type CampaignConfig, type Channel, fmtDate, useActivity } from "./api";

function Bar({ label, pct, className }: { label: string; pct: number; className: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 text-xs text-muted-foreground">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${className}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <span className="w-12 text-right text-xs font-medium">{pct.toFixed(1)}%</span>
    </div>
  );
}

export function ConnectTracking({ channel, config }: { channel: Channel; config: CampaignConfig | undefined }) {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return (
    <SectionCard
      title="Connect tracking"
      description={
        channel === "email"
          ? "Open, click, delivery and bounce numbers appear here once Resend is set to report them. Until then we don't show rates, so nothing here is a guess."
          : "Delivery receipts appear here once Twilio can reach the app. Text messages have no open tracking."
      }
      icon={PlugZap}
    >
      <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
        {channel === "email" ? (
          <>
            <li>In Resend, open <span className="font-medium text-foreground">Webhooks → Add endpoint</span>.</li>
            <li>
              Paste this address:{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-foreground break-all">{origin}{config?.email.webhookPath ?? "/api/campaigns/v1/webhooks/resend"}</code>
            </li>
            <li>Tick the events <span className="font-medium text-foreground">delivered, opened, clicked, bounced, complained</span>.</li>
            <li>Copy the signing secret Resend shows and ask your administrator to save it as <code className="rounded bg-muted px-1 text-xs">RESEND_WEBHOOK_SECRET</code>.</li>
            <li>Turn on open and click tracking for your sending domain in Resend.</li>
          </>
        ) : (
          <>
            <li>Make sure Twilio is connected (account SID, auth token and sending number).</li>
            <li>
              Ask your administrator to set <code className="rounded bg-muted px-1 text-xs">APP_BASE_URL</code> (or{" "}
              <code className="rounded bg-muted px-1 text-xs">TWILIO_WEBHOOK_PUBLIC_HOST</code>) to this site's address so Twilio can report back.
            </li>
            <li>Nothing else to click in Twilio — each campaign text asks Twilio to report its delivery.</li>
          </>
        )}
      </ol>
    </SectionCard>
  );
}

export function TrackingTab({
  channel,
  campaigns,
  connected,
  config,
}: {
  channel: Channel;
  campaigns: Campaign[];
  connected: boolean;
  config: CampaignConfig | undefined;
}) {
  const activity = useActivity(channel, connected);
  if (!connected) return <ConnectTracking channel={channel} config={config} />;

  const sent = campaigns.filter((c) => c.sentCount > 0);
  return (
    <div className="space-y-4">
      <SectionCard
        title={`${channel === "email" ? "Email" : "SMS"} campaign performance`}
        description={channel === "email" ? "Delivery, open and click rates for every campaign that has gone out" : "Delivery rates for every campaign that has gone out"}
      >
        {sent.length === 0 ? (
          <EmptyState compact icon={Link2} title="Nothing sent yet" description="Rates appear here after your first campaign goes out." />
        ) : (
          <div className="space-y-5">
            {sent.map((c) => {
              const pct = (n: number) => (c.sentCount > 0 ? (n / c.sentCount) * 100 : 0);
              return (
                <div key={c.id} className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">{c.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {c.sentCount} sent · {c.deliveredCount} delivered
                      {channel === "email" && ` · ${c.openedCount} opens · ${c.clickedCount} clicks`}
                      {c.bouncedCount > 0 && ` · ${c.bouncedCount} bounced`}
                    </p>
                  </div>
                  <Bar label="Delivered" pct={pct(c.deliveredCount)} className="bg-success" />
                  {channel === "email" && <Bar label="Opened" pct={pct(c.openedCount)} className="bg-accent" />}
                  {channel === "email" && <Bar label="Clicked" pct={pct(c.clickedCount)} className="bg-navy-500" />}
                </div>
              );
            })}
          </div>
        )}
      </SectionCard>

      <SectionCard title="Recent recipient activity" description="The latest deliveries, opens, clicks and unsubscribes">
        {activity.isLoading ? (
          <Skeleton className="h-24" />
        ) : !activity.data?.length ? (
          <EmptyState compact title="No activity yet" description="As providers report back, each event shows up here." />
        ) : (
          <ul className="max-h-80 space-y-1 overflow-y-auto">
            {activity.data.map((a) => {
              const [Icon, label, at, tone] = a.unsubscribedAt
                ? [Ban, "Unsubscribed", a.unsubscribedAt, "text-destructive"]
                : a.bouncedAt
                  ? [AlertTriangle, "Bounced", a.bouncedAt, "text-destructive"]
                  : a.clickedAt
                    ? [MousePointerClick, "Clicked", a.clickedAt, "text-accent"]
                    : a.openedAt
                      ? [Eye, "Opened", a.openedAt, "text-navy-500"]
                      : [CheckCircle2, "Delivered", a.deliveredAt, "text-success"];
              return (
                <li key={a.recipientId} className="flex items-center justify-between gap-3 rounded-md px-3 py-2 text-sm hover:bg-muted/50">
                  <div className="flex min-w-0 items-center gap-3">
                    <Icon className={`h-4 w-4 shrink-0 ${tone}`} />
                    <span className="font-medium truncate">{a.firstName} {a.lastName}</span>
                    <span className="hidden text-xs text-muted-foreground sm:inline">{label} · {a.campaignName}</span>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">{fmtDate(at as string | null, true)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
