// @vitest-environment jsdom
/**
 * Render tests for the Omnichannel Campaigns page. `fetch` is mocked per URL
 * so every number on screen comes from the (fake) API response — the page has
 * no numbers of its own.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getGetMeQueryKey } from "@workspace/api-client-react";
import CampaignsPage from "@/pages/campaigns";

const CONFIG = (connected: boolean) => ({
  email: {
    sendingConfigured: connected,
    unsubscribeConfigured: connected,
    senderAddressConfigured: connected,
    trackingConfigured: connected,
    webhookPath: "/api/campaigns/v1/webhooks/resend",
  },
  sms: { sendingConfigured: connected, trackingConfigured: connected, webhookPath: "/api/campaigns/v1/webhooks/twilio-status" },
  settings: { senderName: "Sunrise", physicalAddress: connected ? "1 Main St" : null, replyToEmail: null, defaultTimeZone: "America/New_York" },
  mergeFields: [{ token: "{{first_name}}", label: "First name" }],
});

const OVERVIEW = (connected: boolean) => ({
  channel: "email",
  campaigns: 1,
  sentCampaigns: 1,
  sent: 42,
  delivered: 40,
  opened: 21,
  clicked: 7,
  bounced: 2,
  failed: 0,
  skippedOptOut: 3,
  unsubscribed: 1,
  optedOutContacts: 4,
  trackingConnected: connected,
  deliveryRate: connected ? 95.2 : null,
  openRate: connected ? 50 : null,
  clickRate: connected ? 16.7 : null,
});

const CAMPAIGN = {
  id: "camp-1",
  channel: "email",
  name: "AEP Kickoff",
  emailTemplateId: null,
  smsTemplateId: null,
  subject: "AEP is here",
  body: "<p>Hi</p>",
  audience: { statuses: ["enrolled"] },
  status: "sent",
  scheduledAt: null,
  startedAt: "2026-09-01T00:00:00Z",
  sentAt: "2026-09-01T00:10:00Z",
  createdAt: "2026-09-01T00:00:00Z",
  recipientCount: 45,
  sentCount: 42,
  deliveredCount: 40,
  openedCount: 21,
  clickedCount: 7,
  bouncedCount: 2,
  failedCount: 0,
  skippedCount: 3,
  unsubscribedCount: 1,
  templateName: null,
  segments: null,
};

let connected = false;
let currentRole = "agency_admin";

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.includes("/api/users/me")) {
      return json({ id: "u1", orgId: "o1", email: "a@x.test", fullName: "A", role: currentRole, isActive: true });
    }
    if (url.includes("/api/campaigns/config")) return json(CONFIG(connected));
    if (url.includes("/api/campaigns/overview")) return json(OVERVIEW(connected));
    if (url.includes("/api/campaigns/activity")) return json([]);
    if (url.includes("/api/campaigns/opt-outs")) {
      return json({
        channel: url.includes("sms") ? "sms" : "email",
        total: 1,
        items: [{ contactId: "c-1", name: "Ann Opted", address: "+15555550100", optedOutAt: "2026-09-02T00:00:00Z", source: "Replied STOP" }],
      });
    }
    if (url.includes("/api/campaigns?channel=email")) return json([CAMPAIGN]);
    if (url.includes("/api/campaigns?channel=sms")) return json([]);
    if (url.includes("/api/sequences")) return json([]);
    if (url.includes("templates")) return json([]);
    return json({});
  });
}

function renderPage(role = "agency_admin") {
  currentRole = role;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  qc.setQueryData(getGetMeQueryKey(), { id: "u1", orgId: "o1", email: "a@x.test", fullName: "A", role, isActive: true });
  const { hook } = memoryLocation({ path: "/campaigns" });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <Router hook={hook}>
          <CampaignsPage />
        </Router>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Omnichannel Campaigns page", () => {
  it("renders real KPI numbers and hides rates until tracking is connected", async () => {
    connected = false;
    renderPage();
    expect(screen.getByRole("heading", { name: "Omnichannel Marketing" })).toBeTruthy();
    expect(await screen.findByText("AEP Kickoff")).toBeTruthy();
    expect(await screen.findByText("42")).toBeTruthy();
    expect(screen.getByText("Open Rate · connect tracking")).toBeTruthy();
    expect(screen.getByText(/Needs setup before emails can go out/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /New Email Campaign/ })).toBeTruthy();
  });

  it("shows rates from the API when tracking is connected", async () => {
    connected = true;
    renderPage();
    expect(await screen.findByText("50%")).toBeTruthy();
    expect(screen.getByText("16.7%")).toBeTruthy();
    expect(screen.queryByText(/Needs setup/)).toBeNull();
  });

  it("Tracking tab explains how to connect instead of showing invented numbers", async () => {
    connected = false;
    renderPage();
    const tab = await screen.findByRole("tab", { name: /Tracking/ });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    expect(await screen.findByText("Connect tracking")).toBeTruthy();
    expect(screen.getByText(/RESEND_WEBHOOK_SECRET/)).toBeTruthy();
  });

  it("SMS opt-outs cannot be reversed from the UI", async () => {
    connected = true;
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /SMS/ }));
    const tab = await screen.findByRole("tab", { name: /SMS Opt-Outs/ });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    const card = (await screen.findByText("Ann Opted")).closest("section")!;
    expect(within(card).getByText(/texting/)).toBeTruthy();
    expect(within(card).queryByRole("button", { name: /Re-subscribe/ })).toBeNull();
  });

  it("read-only roles don't get the New campaign button", async () => {
    connected = true;
    renderPage("compliance_manager");
    await screen.findByText("AEP Kickoff");
    await waitFor(() => expect(screen.queryByRole("button", { name: /New Email Campaign/ })).toBeNull());
  });
});
