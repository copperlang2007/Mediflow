/**
 * Omnichannel Campaigns — email + SMS marketing, modelled on agencyBRIDGE's
 * EmailCampaignPage: Email/SMS toggle, four KPI tiles, and tabs for
 * Campaigns / Templates / Tracking / Unsubscribes / Drip Sequences.
 *
 * Everything here is real: campaigns, recipients and counts come from
 * /api/campaigns*, templates reuse the existing template CRUD, and the Drip
 * Sequences tab embeds the existing sequences UI. When sending or tracking
 * isn't configured the page says so ("Needs setup" / "Connect tracking")
 * instead of showing invented rates.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { customFetch, useGetMe } from "@workspace/api-client-react";
import {
  AlertCircle,
  Ban,
  Calendar,
  CheckCircle2,
  Edit2,
  Eye,
  FileText,
  Mail,
  MessageSquare,
  MoreHorizontal,
  MousePointerClick,
  Plus,
  Settings2,
  Trash2,
  TrendingUp,
  XCircle,
  Zap,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState, MiniStat, PageHeader, StatusPill, TechnicalDetails, type StatusTone } from "@/components/shared";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import SequencesTab from "@/pages/crm/SequencesTab";
import {
  type Campaign,
  type CampaignConfig,
  type Channel,
  QK,
  describeAudience,
  errorMessage,
  fmtDate,
  jsonInit,
  useCampaignConfig,
  useCampaigns,
  useOverview,
} from "./campaigns/api";
import { CampaignBuilderDialog } from "./campaigns/CampaignBuilder";
import { TemplatesTab } from "./campaigns/TemplatesTab";
import { TrackingTab } from "./campaigns/TrackingTab";
import { OptOutsTab } from "./campaigns/OptOutsTab";
import { CampaignDetail } from "./campaigns/CampaignDetail";
import { SettingsDialog } from "./campaigns/SettingsDialog";

const STATUS_TONE: Record<Campaign["status"], StatusTone> = {
  draft: "neutral",
  scheduled: "navy",
  sending: "warning",
  sent: "success",
  cancelled: "danger",
};

function ChannelToggle({ channel, onChange }: { channel: Channel; onChange: (c: Channel) => void }) {
  const btn = (c: Channel, Icon: typeof Mail, label: string) => (
    <button
      type="button"
      onClick={() => onChange(c)}
      aria-pressed={channel === c}
      className={cn(
        "flex items-center gap-2 rounded-lg px-4 py-1.5 text-sm font-medium transition-colors",
        channel === c
          ? "bg-navy-100 text-navy-800 shadow-sm dark:bg-secondary dark:text-secondary-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="h-4 w-4" /> {label}
    </button>
  );
  return (
    <div className="inline-flex items-center gap-1 rounded-xl border border-border bg-card p-1 shadow-sm" role="group" aria-label="Channel">
      {btn("email", Mail, "Email")}
      {btn("sms", MessageSquare, "SMS")}
    </div>
  );
}

function SetupNotice({ channel, config, canManage, onOpenSettings }: {
  channel: Channel;
  config: CampaignConfig | undefined;
  canManage: boolean;
  onOpenSettings: () => void;
}) {
  if (!config) return null;
  // Plain words for agents; the server setting names go in the admin-only
  // "Technical details" disclosure.
  const missing: string[] = [];
  const technical: string[] = [];
  if (channel === "email") {
    if (!config.email.sendingConfigured) {
      missing.push("connect your email sending service");
      technical.push("Email sending: set RESEND_API_KEY on the server.");
    }
    if (!config.email.unsubscribeConfigured) {
      missing.push("turn on the unsubscribe link every marketing email must include");
      technical.push("Unsubscribe links: set CAMPAIGN_UNSUBSCRIBE_SECRET and APP_BASE_URL on the server.");
    }
    if (!config.email.senderAddressConfigured) missing.push("add your agency's mailing address in Settings");
  } else if (!config.sms.sendingConfigured) {
    missing.push("connect your text messaging account and sending number");
    technical.push("Texting: set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER on the server.");
  }
  if (missing.length === 0) return null;
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-warning/30 bg-warning/10 p-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex gap-3">
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
        <div className="text-sm">
          <p className="font-medium">Needs setup before {channel === "email" ? "emails" : "texts"} can go out</p>
          <p className="mt-0.5 text-muted-foreground">
            You can build campaigns and templates now. To send, an administrator needs to {missing.join("; ")}. Nothing is sent until then.
          </p>
          {technical.length > 0 && (
            <TechnicalDetails>
              {technical.map((t) => <div key={t}>{t}</div>)}
            </TechnicalDetails>
          )}
        </div>
      </div>
      {canManage && channel === "email" && !config.email.senderAddressConfigured && (
        <Button size="sm" variant="outline" onClick={onOpenSettings} className="shrink-0">Open settings</Button>
      )}
    </div>
  );
}

function CampaignRow({
  c,
  canDraft,
  canManage,
  onOpen,
  onEdit,
}: {
  c: Campaign;
  canDraft: boolean;
  canManage: boolean;
  onOpen: () => void;
  onEdit: () => void;
}) {
  const qc = useQueryClient();
  const cancel = useMutation({
    mutationFn: () => customFetch(`/api/campaigns/${c.id}/cancel`, jsonInit("POST", {})),
    onSuccess: () => {
      toast.success("Campaign cancelled");
      void qc.invalidateQueries({ queryKey: QK.all });
    },
    onError: (e) => toast.error(errorMessage(e, "Could not cancel")),
  });
  const remove = useMutation({
    mutationFn: () => customFetch(`/api/campaigns/${c.id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Campaign deleted");
      void qc.invalidateQueries({ queryKey: QK.all });
    },
    onError: (e) => toast.error(errorMessage(e, "Could not delete")),
  });
  const Icon = c.channel === "sms" ? MessageSquare : Mail;
  const reached = c.status === "sent" || c.status === "sending" || c.sentCount > 0;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onOpen()}
      className="flex cursor-pointer items-center justify-between gap-4 rounded-xl border border-border bg-card p-4 shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex min-w-0 items-center gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-navy-800 dark:text-secondary-foreground">
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <p className="font-display font-semibold truncate">{c.name}</p>
          <p className="mt-0.5 text-xs text-muted-foreground truncate">
            {c.templateName ?? "Custom message"} · {describeAudience(c.audience)}
            {c.status !== "draft" && ` · ${c.recipientCount} recipient${c.recipientCount === 1 ? "" : "s"}`}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {reached && (
          <div className="hidden items-center gap-4 text-sm text-muted-foreground md:flex">
            <span>{c.sentCount} sent</span>
            {c.channel === "email" ? (
              <>
                <span>{c.openedCount} opens</span>
                <span>{c.clickedCount} clicks</span>
              </>
            ) : (
              <span>{c.deliveredCount} delivered</span>
            )}
          </div>
        )}
        {c.status === "scheduled" && c.scheduledAt && (
          <span className="hidden items-center gap-1 text-xs text-accent sm:flex">
            <Calendar className="h-3.5 w-3.5" />
            {fmtDate(c.scheduledAt, true)}
          </span>
        )}
        <StatusPill tone={STATUS_TONE[c.status]} className="lowercase">{c.status}</StatusPill>
        {(canDraft || canManage) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0" aria-label={`Actions for ${c.name}`}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuItem onClick={onOpen}>
                <Eye className="mr-2 h-3.5 w-3.5" />View details
              </DropdownMenuItem>
              {c.status === "draft" && canDraft && (
                <DropdownMenuItem onClick={onEdit}>
                  <Edit2 className="mr-2 h-3.5 w-3.5" />Edit
                </DropdownMenuItem>
              )}
              {(c.status === "scheduled" || c.status === "sending") && canManage && (
                <DropdownMenuItem onClick={() => cancel.mutate()}>
                  <XCircle className="mr-2 h-3.5 w-3.5" />Cancel sending
                </DropdownMenuItem>
              )}
              {(c.status === "draft" || (c.status === "cancelled" && c.sentCount === 0)) && canManage && (
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={() => window.confirm(`Delete "${c.name}"?`) && remove.mutate()}
                >
                  <Trash2 className="mr-2 h-3.5 w-3.5" />Delete
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}

export default function CampaignsPage() {
  const { data: me } = useGetMe();
  const role = me?.role ?? null;
  const canManage = role === "super_admin" || role === "agency_admin";
  const canDraft = canManage || role === "agent_support";
  const canEditTemplates = canDraft || role === "compliance_manager";

  const [channel, setChannel] = useState<Channel>("email");
  const [tab, setTab] = useState("campaigns");
  const [viewing, setViewing] = useState<string | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editing, setEditing] = useState<Campaign | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const { data: config } = useCampaignConfig();
  const overview = useOverview(channel);
  const campaigns = useCampaigns(channel);
  const o = overview.data;
  const connected = !!o?.trackingConnected;
  const pct = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${v}%`);

  const switchChannel = (c: Channel) => {
    setChannel(c);
    setViewing(null);
    if (tab === "drips") return;
    setTab("campaigns");
  };

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Omnichannel Marketing"
        subtitle="Build email and SMS campaigns, track engagement, manage opt-outs."
      >
        <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
          <Settings2 className="mr-1.5 h-4 w-4" />Settings
        </Button>
      </PageHeader>

      <div className="flex items-center justify-between gap-3">
        <ChannelToggle channel={channel} onChange={switchChannel} />
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium">
          {channel === "email" ? <Mail className="h-3 w-3" /> : <MessageSquare className="h-3 w-3" />}
          {channel === "email" ? "Email Mode" : "SMS Mode"}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {channel === "email" ? (
          <>
            <MiniStat icon={Mail} label="Total Sent" value={o?.sent ?? 0} loading={overview.isLoading} />
            <MiniStat icon={Eye} label={connected ? "Open Rate" : "Open Rate · connect tracking"} value={pct(o?.openRate)} loading={overview.isLoading} />
            <MiniStat icon={MousePointerClick} label={connected ? "Click Rate" : "Click Rate · connect tracking"} value={pct(o?.clickRate)} loading={overview.isLoading} />
            <MiniStat icon={Ban} label="Unsubscribes" value={o?.unsubscribed ?? 0} tone="danger" loading={overview.isLoading} />
          </>
        ) : (
          <>
            <MiniStat icon={MessageSquare} label="Total Sent" value={o?.sent ?? 0} loading={overview.isLoading} />
            <MiniStat icon={CheckCircle2} label={connected ? "Delivery Rate" : "Delivery Rate · connect tracking"} value={pct(o?.deliveryRate)} tone="success" loading={overview.isLoading} />
            <MiniStat icon={XCircle} label="Failed" value={o?.failed ?? 0} loading={overview.isLoading} />
            <MiniStat icon={Ban} label="Opt-Outs" value={o?.optedOutContacts ?? 0} tone="danger" loading={overview.isLoading} />
          </>
        )}
      </div>

      <SetupNotice channel={channel} config={config} canManage={canManage} onOpenSettings={() => setSettingsOpen(true)} />

      <Tabs value={tab} onValueChange={(t) => { setTab(t); setViewing(null); }} className="space-y-4">
        <TabsList className="h-auto flex-wrap gap-1 rounded-xl border border-border bg-card p-1 shadow-sm">
          <TabsTrigger value="campaigns" className="gap-1.5">
            {channel === "sms" ? <MessageSquare className="h-4 w-4" /> : <Mail className="h-4 w-4" />}Campaigns
          </TabsTrigger>
          <TabsTrigger value="templates" className="gap-1.5"><FileText className="h-4 w-4" />Templates</TabsTrigger>
          <TabsTrigger value="tracking" className="gap-1.5"><TrendingUp className="h-4 w-4" />Tracking</TabsTrigger>
          <TabsTrigger value="optouts" className="gap-1.5"><Ban className="h-4 w-4" />{channel === "sms" ? "SMS Opt-Outs" : "Unsubscribes"}</TabsTrigger>
          <TabsTrigger value="drips" className="gap-1.5"><Zap className="h-4 w-4" />Drip Sequences</TabsTrigger>
        </TabsList>

        <TabsContent value="campaigns" className="space-y-4">
          {viewing ? (
            <CampaignDetail id={viewing} onBack={() => setViewing(null)} trackingConnected={connected} />
          ) : (
            <>
              {canDraft && (
                <div className="flex justify-end">
                  <Button onClick={() => { setEditing(null); setBuilderOpen(true); }}>
                    <Plus className="mr-1.5 h-4 w-4" />New {channel === "sms" ? "SMS" : "Email"} Campaign
                  </Button>
                </div>
              )}
              {campaigns.isLoading ? (
                <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-[72px] rounded-xl" />)}</div>
              ) : !campaigns.data?.length ? (
                <div className="rounded-xl border border-border bg-card shadow-sm">
                  <EmptyState
                    icon={channel === "email" ? Mail : MessageSquare}
                    title={`No ${channel === "email" ? "email" : "SMS"} campaigns yet`}
                    description={
                      channel === "email"
                        ? "Send one email to many clients at once — an AEP reminder, a birthday note, a plan-change heads-up. Opted-out clients are skipped automatically."
                        : "Text many clients at once. Clients who replied STOP are skipped, and texts only go out 8am–9pm in each client's time zone."
                    }
                    action={canDraft ? { label: "Create your first campaign", onClick: () => { setEditing(null); setBuilderOpen(true); } } : undefined}
                  />
                </div>
              ) : (
                <div className="grid gap-3">
                  {campaigns.data.map((c) => (
                    <CampaignRow
                      key={c.id}
                      c={c}
                      canDraft={canDraft}
                      canManage={canManage}
                      onOpen={() => setViewing(c.id)}
                      onEdit={() => { setEditing(c); setBuilderOpen(true); }}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </TabsContent>

        <TabsContent value="templates">
          <TemplatesTab channel={channel} canEdit={canEditTemplates} canDelete={canManage} />
        </TabsContent>

        <TabsContent value="tracking">
          <TrackingTab channel={channel} campaigns={campaigns.data ?? []} connected={connected} config={config} />
        </TabsContent>

        <TabsContent value="optouts">
          <OptOutsTab channel={channel} canManage={canManage} />
        </TabsContent>

        <TabsContent value="drips" className="space-y-4">
          <div>
            <h3 className="flex items-center gap-2 font-display text-sm font-semibold">
              <Zap className="h-4 w-4 text-accent" />Automated drip sequences
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Timed series of emails, texts and follow-up tasks. The same sequences live under Clients &amp; Leads → Sequences; opt-outs are honoured at every step.
            </p>
          </div>
          <SequencesTab />
        </TabsContent>
      </Tabs>

      <CampaignBuilderDialog
        open={builderOpen}
        onOpenChange={setBuilderOpen}
        channel={channel}
        campaign={editing}
        canSend={canManage}
        config={config}
      />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} config={config} canEdit={canManage} />
    </div>
  );
}
