/**
 * Types + React Query hooks for the Omnichannel Campaigns page. Calls the
 * `/api/campaigns*` routes (artifacts/api-server/src/routes/campaigns.ts)
 * with the shared `customFetch`, the same way the Marketing Approval page does.
 */
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";

export type Channel = "email" | "sms";
export type CampaignStatus = "draft" | "scheduled" | "sending" | "sent" | "cancelled";

export interface Audience {
  statuses?: string[];
  planTypes?: string[];
  carrierIds?: string[];
  states?: string[];
  sources?: string[];
  tags?: string[];
  birthdayMonth?: number;
}

export interface Campaign {
  id: string;
  channel: Channel;
  name: string;
  emailTemplateId: string | null;
  smsTemplateId: string | null;
  subject: string | null;
  body: string | null;
  audience: Audience;
  status: CampaignStatus;
  scheduledAt: string | null;
  startedAt: string | null;
  sentAt: string | null;
  createdAt: string;
  recipientCount: number;
  sentCount: number;
  deliveredCount: number;
  openedCount: number;
  clickedCount: number;
  bouncedCount: number;
  failedCount: number;
  skippedCount: number;
  unsubscribedCount: number;
  templateName: string | null;
  segments: number | null;
}

export interface CampaignRecipientRow {
  id: string;
  contactId: string;
  firstName: string;
  lastName: string;
  status: string;
  sentAt: string | null;
  deliveredAt: string | null;
  openedAt: string | null;
  clickedAt: string | null;
  unsubscribedAt: string | null;
  error: string | null;
}

export interface CampaignDetail extends Campaign {
  recipients: CampaignRecipientRow[];
}

export interface Overview {
  channel: Channel;
  campaigns: number;
  sentCampaigns: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  failed: number;
  skippedOptOut: number;
  unsubscribed: number;
  optedOutContacts: number;
  trackingConnected: boolean;
  deliveryRate: number | null;
  openRate: number | null;
  clickRate: number | null;
}

export interface CampaignConfig {
  email: {
    sendingConfigured: boolean;
    unsubscribeConfigured: boolean;
    senderAddressConfigured: boolean;
    trackingConfigured: boolean;
    webhookPath: string;
  };
  sms: { sendingConfigured: boolean; trackingConfigured: boolean; webhookPath: string };
  settings: {
    senderName: string;
    physicalAddress: string | null;
    replyToEmail: string | null;
    defaultTimeZone: string;
  };
  mergeFields: Array<{ token: string; label: string }>;
}

export interface AudiencePreview {
  matched: number;
  eligible: number;
  optedOut: number;
  missingAddress: number;
}

export interface AudienceOptions {
  states: string[];
  sources: string[];
  tags: string[];
  carriers: Array<{ id: string; name: string }>;
}

export interface OptOutItem {
  contactId: string | null;
  name: string | null;
  address: string | null;
  optedOutAt: string | null;
  source: string;
}

export interface ActivityRow {
  recipientId: string;
  campaignId: string;
  campaignName: string;
  contactId: string;
  firstName: string;
  lastName: string;
  status: string;
  sentAt: string | null;
  deliveredAt: string | null;
  openedAt: string | null;
  clickedAt: string | null;
  bouncedAt: string | null;
  unsubscribedAt: string | null;
}

export const QK = {
  all: ["campaigns"] as const,
  list: (channel: Channel) => ["campaigns", "list", channel] as const,
  overview: (channel: Channel) => ["campaigns", "overview", channel] as const,
  config: ["campaigns", "config"] as const,
  detail: (id: string) => ["campaigns", "detail", id] as const,
  optOuts: (channel: Channel) => ["campaigns", "opt-outs", channel] as const,
  activity: (channel: Channel) => ["campaigns", "activity", channel] as const,
  options: ["campaigns", "audience-options"] as const,
};

export function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

export function useCampaigns(channel: Channel) {
  return useQuery({
    queryKey: QK.list(channel),
    queryFn: () => customFetch<Campaign[]>(`/api/campaigns?channel=${channel}`),
  });
}

export function useOverview(channel: Channel) {
  return useQuery({
    queryKey: QK.overview(channel),
    queryFn: () => customFetch<Overview>(`/api/campaigns/overview?channel=${channel}`),
  });
}

export function useCampaignConfig() {
  return useQuery({
    queryKey: QK.config,
    queryFn: () => customFetch<CampaignConfig>("/api/campaigns/config"),
  });
}

export function useCampaignDetail(id: string | null) {
  return useQuery({
    queryKey: QK.detail(id ?? "none"),
    queryFn: () => customFetch<CampaignDetail>(`/api/campaigns/${id}`),
    enabled: Boolean(id),
  });
}

export function useOptOuts(channel: Channel) {
  return useQuery({
    queryKey: QK.optOuts(channel),
    queryFn: () =>
      customFetch<{ channel: Channel; total: number; items: OptOutItem[] }>(
        `/api/campaigns/opt-outs?channel=${channel}`,
      ),
  });
}

export function useActivity(channel: Channel, enabled: boolean) {
  return useQuery({
    queryKey: QK.activity(channel),
    queryFn: () => customFetch<ActivityRow[]>(`/api/campaigns/activity?channel=${channel}`),
    enabled,
  });
}

export function useAudienceOptions(enabled: boolean) {
  return useQuery({
    queryKey: QK.options,
    queryFn: () => customFetch<AudienceOptions>("/api/campaigns/audience/options"),
    enabled,
    staleTime: 60_000,
  });
}

export function errorMessage(err: unknown, fallback: string): string {
  const e = err as { data?: { error?: string }; message?: string } | null;
  return e?.data?.error ?? e?.message ?? fallback;
}

export const STATUS_LABELS: Record<string, string> = {
  lead: "Leads",
  prospect: "Prospects",
  enrolled: "Enrolled",
  retained: "Retained",
  lost: "Lost",
};

export const PLAN_LABELS: Record<string, string> = {
  MA: "Medicare Advantage",
  MAPD: "MAPD",
  PDP: "Part D",
  supp: "Supplement",
  other: "Other",
};

export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Short human description of an audience filter, e.g. "Enrolled · MAPD · TX". */
export function describeAudience(a: Audience | null | undefined): string {
  if (!a) return "All clients";
  const parts: string[] = [];
  if (a.statuses?.length) parts.push(a.statuses.map((s) => STATUS_LABELS[s] ?? s).join(", "));
  if (a.planTypes?.length) parts.push(a.planTypes.map((p) => PLAN_LABELS[p] ?? p).join(", "));
  if (a.carrierIds?.length) parts.push(`${a.carrierIds.length} carrier${a.carrierIds.length === 1 ? "" : "s"}`);
  if (a.states?.length) parts.push(a.states.join(", "));
  if (a.sources?.length) parts.push(a.sources.join(", "));
  if (a.tags?.length) parts.push(a.tags.map((t) => `#${t}`).join(" "));
  if (a.birthdayMonth) parts.push(`${MONTHS[a.birthdayMonth - 1]} birthdays`);
  return parts.length ? parts.join(" · ") : "All clients";
}

export function smsSegments(body: string): number {
  if (!body) return 0;
  // eslint-disable-next-line no-control-regex
  const gsm = /^[\x0A\x0D\x20-\x7E£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¤¡ÄÖÑÜ§¿äöñüà€^{}\\[~\]|]*$/.test(body);
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  return body.length <= single ? 1 : Math.ceil(body.length / multi);
}

export function fmtDate(iso: string | null | undefined, withTime = false): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
  });
}
