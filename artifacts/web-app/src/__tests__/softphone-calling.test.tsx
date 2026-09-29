// @vitest-environment jsdom
/**
 * Softphone browser-calling states: needs setup, ready, refused (exact reason),
 * and a full call through a fake Twilio Device (params, mute, hang up, timer,
 * post-call notes). `fetch` is mocked per URL and the Twilio SDK is faked — no
 * real call, token or network is involved.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getGetMeQueryKey } from "@workspace/api-client-react";

const fake = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  const state = {
    connectParams: [] as Record<string, string>[],
    calls: [] as FakeCall[],
    tokens: [] as string[],
    destroyed: 0,
    /** When set, Device.connect() waits for it — lets a test abandon a call mid-connect. */
    gate: null as Promise<void> | null,
  };
  class FakeCall {
    handlers: Record<string, Handler[]> = {};
    muted = false;
    disconnected = false;
    on(evt: string, fn: Handler) { (this.handlers[evt] ??= []).push(fn); return this; }
    emit(evt: string, ...args: unknown[]) { (this.handlers[evt] ?? []).forEach((h) => h(...args)); }
    mute(m = true) { this.muted = m; this.emit("mute", m); }
    disconnect() { this.disconnected = true; this.emit("disconnect"); }
  }
  class FakeDevice {
    constructor(token: string) { state.tokens.push(token); }
    on() { return this; }
    updateToken() {}
    destroy() { state.destroyed += 1; }
    async connect(opts: { params: Record<string, string> }) {
      state.connectParams.push(opts.params);
      if (state.gate) await state.gate;
      const c = new FakeCall();
      state.calls.push(c);
      return c;
    }
  }
  return { state, FakeDevice, FakeCall };
});

vi.mock("@twilio/voice-sdk", () => ({
  Device: fake.FakeDevice,
  Call: { Codec: { Opus: "opus", PCMU: "pcmu" } },
}));

import DialerPage from "@/pages/DialerPage";

const ADMIN = { id: "u-admin", orgId: "o-1", email: "a@example.com", fullName: "Admin", role: "agency_admin", isActive: true };
const SUPPORT = { ...ADMIN, id: "u-support", role: "agent_support" };
const VIEWER = { ...ADMIN, id: "u-viewer", role: "viewer" };

const CONTACT = {
  id: "c-1", firstName: "Joan", lastName: "Park", email: "joan@example.com", phone: "+15035551234",
  status: "enrolled", stateCode: "OR", zipCode: "97201", currentPlanType: "supp", assignedAgentId: null,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function renderAt(path: string, user = ADMIN) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  qc.setQueryData(getGetMeQueryKey(), user);
  const [pathname, search = ""] = path.split("?");
  const { hook, searchHook } = memoryLocation({ path: pathname, searchPath: search, static: true } as never) as unknown as {
    hook: never; searchHook: never;
  };
  return render(
    <QueryClientProvider client={qc}>
      <Router hook={hook} searchHook={searchHook}>
        <TooltipProvider><DialerPage /></TooltipProvider>
      </Router>
    </QueryClientProvider>,
  );
}

type RouteFn = (url: string, init?: RequestInit) => Response;
let routes: Record<string, RouteFn>;
let fetchMock: ReturnType<typeof vi.fn>;

const TOKEN = { token: "header.payload.signature", identity: "u_admin", expiresAt: new Date(Date.now() + 600_000).toISOString(), ttlSeconds: 600 };

beforeEach(() => {
  fake.state.connectParams.length = 0;
  fake.state.calls.length = 0;
  fake.state.tokens.length = 0;
  fake.state.destroyed = 0;
  fake.state.gate = null;
  routes = {
    "/api/softphone/recent-calls": () => json({ data: [], total: 0 }),
    "/api/softphone/dispositions": () => json({ data: [{ code: "FOLLOW_UP", label: "Call back / follow up" }, { code: "DO_NOT_CALL", label: "Do not call again" }] }),
    "/api/contacts/c-1": () => json(CONTACT),
    "/api/softphone/precheck": () => json({
      okToCall: true, checks: { consent: true, dncClear: true, withinCallingHours: true, agentEligible: true },
      failures: [], agent: null, productLine: "supp", planYear: 2026,
      callingHours: { startHour: 8, endHour: 21, timezone: "America/Los_Angeles", localTime: "12:00 PM" }, checkedAt: new Date().toISOString(),
    }),
  };
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const hit = Object.keys(routes).sort((a, b) => b.length - a.length).find((k) => url.includes(k));
    return hit ? routes[hit](url, init) : json({ error: "not found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function calledUrls(): string[] {
  return fetchMock.mock.calls.map((c) => String(c[0]));
}

describe("Softphone browser calling states", () => {
  it("shows an honest 'Needs setup' (with the missing names for admins) and disables Call", async () => {
    routes["/api/softphone/voice-token"] = () => json({ status: "needs_setup", missing: ["TWILIO_API_KEY_SECRET", "TWILIO_TWIML_APP_SID"] }, 503);
    renderAt("/dialer?contact=c-1");
    expect(await screen.findByText(/Browser calling: needs setup/)).toBeInTheDocument();
    expect(screen.getByText("Needs setup")).toBeInTheDocument();
    expect(screen.getByText(/TWILIO_API_KEY_SECRET, TWILIO_TWIML_APP_SID/)).toBeInTheDocument();
    await screen.findAllByText("Joan Park");
    for (const b of screen.getAllByRole("button", { name: /^Call$/ })) expect(b).toBeDisabled();
    expect(screen.getByTestId("call-hint")).toHaveTextContent("Browser calling needs setup.");
    expect(calledUrls().some((u) => u.includes("/api/softphone/calls"))).toBe(false);
  });

  it("hides the missing names from non-admin roles", async () => {
    routes["/api/softphone/voice-token"] = () => json({ status: "needs_setup", missing: ["TWILIO_API_KEY_SECRET"] }, 503);
    renderAt("/dialer", SUPPORT);
    expect(await screen.findByText("Needs setup")).toBeInTheDocument();
    expect(screen.queryByText(/TWILIO_API_KEY_SECRET/)).not.toBeInTheDocument();
    expect(screen.getByText(/Ask your agency administrator/)).toBeInTheDocument();
  });

  it("roles that cannot place calls see no calling UI and mint no token", async () => {
    routes["/api/softphone/voice-token"] = () => json(TOKEN);
    renderAt("/dialer", VIEWER);
    expect(await screen.findByTestId("call-hint")).toHaveTextContent("Your role can't place calls.");
    expect(calledUrls().some((u) => u.includes("voice-token"))).toBe(false);
  });

  it("you can only call a contact on file: typing a number is not enough", async () => {
    routes["/api/softphone/voice-token"] = () => json(TOKEN);
    routes["/api/softphone/lookup"] = () => json({ data: [], total: 0 });
    renderAt("/dialer");
    expect(await screen.findByText(/Browser calling: ready/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "5035559999" } });
    await waitFor(() => expect(calledUrls().some((u) => u.includes("/api/softphone/lookup"))).toBe(true));
    expect(screen.getByRole("button", { name: /^Call$/ })).toBeDisabled();
    expect(screen.getByTestId("call-hint")).toHaveTextContent(/contact on file|Pick a contact/);
  });

  it("shows the server's exact refusal reasons and never opens a device", async () => {
    routes["/api/softphone/voice-token"] = () => json(TOKEN);
    routes["/api/softphone/calls"] = () => json({
      error: "outside permitted calling hours for America/Los_Angeles",
      code: "OUTSIDE_CALLING_HOURS",
      reasons: [
        { code: "OUTSIDE_CALLING_HOURS", detail: "outside permitted calling hours for America/Los_Angeles" },
        { code: "REDIAL_COOLDOWN", detail: "redial cooldown: wait 12 more minute(s) (minimum gap 30 minutes)" },
      ],
      callSessionId: "blocked-1",
    }, 409);
    renderAt("/dialer?contact=c-1");
    await screen.findByText(/Browser calling: ready/);
    await screen.findAllByText("Joan Park");
    fireEvent.click(screen.getAllByRole("button", { name: /^Call$/ })[0]);
    expect(await screen.findByText("Call blocked")).toBeInTheDocument();
    expect(screen.getByText("outside permitted calling hours for America/Los_Angeles")).toBeInTheDocument();
    expect(screen.getByText("redial cooldown: wait 12 more minute(s) (minimum gap 30 minutes)")).toBeInTheDocument();
    expect(fake.state.connectParams).toHaveLength(0);
    expect(fake.state.tokens).toHaveLength(0);
    // The request named only the contact — never a phone number.
    const post = fetchMock.mock.calls.find((c) => String(c[0]).includes("/api/softphone/calls"))!;
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ contactId: "c-1" });
  });

  it("runs a call end to end: connect params, live timer, mute, hang up, post-call notes", async () => {
    routes["/api/softphone/voice-token"] = () => json(TOKEN);
    routes["/api/softphone/calls/"] = (_u, init) => {
      expect(init?.method).toBe("PATCH");
      return json({ id: "sess-1", status: "completed", dispositionCode: null, notes: "left voicemail" });
    };
    routes["/api/softphone/calls"] = (_u, init) =>
      init?.method === "POST" ? json({ callSessionId: "sess-1", to: "+15035551234" }, 201) : json({ data: [] });

    renderAt("/dialer?contact=c-1");
    await screen.findByText(/Browser calling: ready/);
    await screen.findAllByText("Joan Park");
    fireEvent.click(screen.getAllByRole("button", { name: /^Call$/ })[0]);

    await waitFor(() => expect(fake.state.connectParams).toHaveLength(1));
    // Only the server-issued session id and the number it returned go to Twilio.
    expect(fake.state.connectParams[0]).toEqual({ callSessionId: "sess-1", To: "+15035551234" });
    expect(fake.state.tokens).toEqual([TOKEN.token]);
    expect(await screen.findByText("Ringing…")).toBeInTheDocument();

    const call = fake.state.calls[0];
    act(() => call.emit("accept"));
    expect(await screen.findByText("In call")).toBeInTheDocument();
    expect(screen.getByLabelText("Call timer")).toHaveTextContent(/^00:0\d$/);

    fireEvent.click(screen.getByRole("button", { name: /^Mute$/ }));
    expect(call.muted).toBe(true);
    expect(await screen.findByRole("button", { name: /^Unmute$/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Hang up/ }));
    expect(call.disconnected).toBe(true);
    expect(await screen.findByText("Call ended")).toBeInTheDocument();

    fireEvent.change(document.getElementById("postcall-notes")!, { target: { value: "left voicemail" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save call$/ }));
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "PATCH");
      expect(patch).toBeTruthy();
      expect(String(patch![0])).toContain("/api/softphone/calls/sess-1");
      expect(JSON.parse(String((patch![1] as RequestInit).body))).toEqual({ notes: "left voicemail" });
    });
    // Form closes once saved.
    await waitFor(() => expect(screen.queryByText("Call ended")).not.toBeInTheDocument());
  });

  it("hanging up while 'Connecting…' abandons the attempt: a late call is disconnected and the Device destroyed", async () => {
    let release!: () => void;
    fake.state.gate = new Promise<void>((r) => { release = r; });
    routes["/api/softphone/voice-token"] = () => json(TOKEN);
    routes["/api/softphone/calls"] = () => json({ callSessionId: "sess-3", to: "+15035551234" }, 201);
    renderAt("/dialer?contact=c-1");
    await screen.findByText(/Browser calling: ready/);
    await screen.findAllByText("Joan Park");
    fireEvent.click(screen.getAllByRole("button", { name: /^Call$/ })[0]);
    await waitFor(() => expect(fake.state.connectParams).toHaveLength(1));
    expect(screen.getByText("Connecting…")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Hang up/ }));
    expect(await screen.findByText("Call ended")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/hung up before the call connected/);
    // The never-dialed session is released server side so a retry isn't blocked.
    await waitFor(() =>
      expect(calledUrls().some((u) => u.includes("/api/softphone/calls/sess-3/cancel"))).toBe(true),
    );

    // Twilio finally hands back the call: it must not go live.
    await act(async () => { release(); await Promise.resolve(); });
    await waitFor(() => expect(fake.state.calls[0].disconnected).toBe(true));
    expect(fake.state.destroyed).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("Ringing…")).not.toBeInTheDocument();
    expect(screen.queryByText("In call")).not.toBeInTheDocument();
  });

  it("leaving the page before the Device exists creates no Device and no call", async () => {
    let releaseToken!: () => void;
    const tokenGate = new Promise<void>((r) => { releaseToken = r; });
    let tokenCalls = 0;
    routes["/api/softphone/voice-token"] = () => {
      tokenCalls += 1;
      return tokenCalls === 1 ? json(TOKEN) : (tokenGate.then(() => json(TOKEN)) as unknown as Response);
    };
    routes["/api/softphone/calls"] = () => json({ callSessionId: "sess-4", to: "+15035551234" }, 201);
    const view = renderAt("/dialer?contact=c-1");
    await screen.findByText(/Browser calling: ready/);
    await screen.findAllByText("Joan Park");
    fireEvent.click(screen.getAllByRole("button", { name: /^Call$/ })[0]);
    await waitFor(() => expect(tokenCalls).toBe(2));

    view.unmount();
    await act(async () => { releaseToken(); await new Promise((r) => setTimeout(r, 20)); });
    expect(fake.state.tokens).toHaveLength(0);
    expect(fake.state.connectParams).toHaveLength(0);
    expect(fake.state.calls).toHaveLength(0);
  });

  it("the live panel keeps the name of the person called even if the picker moves on", async () => {
    routes["/api/softphone/voice-token"] = () => json(TOKEN);
    routes["/api/softphone/calls"] = () => json({ callSessionId: "sess-5", to: "+15035551234" }, 201);
    renderAt("/dialer?contact=c-1");
    await screen.findByText(/Browser calling: ready/);
    await screen.findAllByText("Joan Park");
    fireEvent.click(screen.getAllByRole("button", { name: /^Call$/ })[0]);
    await waitFor(() => expect(fake.state.calls).toHaveLength(1));
    expect(await screen.findByText("Ringing…")).toBeInTheDocument();

    // Deselect the contact mid-call (the card's Clear button).
    const clear = screen.getAllByRole("button", { name: /^Clear$/ }).filter((b) => !(b as HTMLButtonElement).disabled).at(-1)!; // the contact card's Clear (the dial pad's comes first)
    fireEvent.click(clear);
    await waitFor(() => expect(screen.queryByText("Caller")).toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByText("Joan Park")).toHaveLength(1));
    expect(screen.getByText("Live call")).toBeInTheDocument();
    expect(screen.queryByText("this contact")).not.toBeInTheDocument();
  });

  it("an ended call keeps Call disabled until the notes are saved or skipped", async () => {
    routes["/api/softphone/voice-token"] = () => json(TOKEN);
    routes["/api/softphone/calls"] = () => json({ callSessionId: "sess-6", to: "+15035551234" }, 201);
    renderAt("/dialer?contact=c-1");
    await screen.findByText(/Browser calling: ready/);
    await screen.findAllByText("Joan Park");
    fireEvent.click(screen.getAllByRole("button", { name: /^Call$/ })[0]);
    await waitFor(() => expect(fake.state.calls).toHaveLength(1));
    act(() => fake.state.calls[0].emit("accept"));
    fireEvent.click(await screen.findByRole("button", { name: /Hang up/ }));
    expect(await screen.findByText("Call ended")).toBeInTheDocument();

    for (const b of screen.getAllByRole("button", { name: /^Call$/ })) expect(b).toBeDisabled();
    expect(screen.getByTestId("call-hint")).toHaveTextContent(/Save or skip/);

    fireEvent.click(screen.getByRole("button", { name: /^Skip$/ }));
    await waitFor(() => expect(screen.queryByText("Call ended")).not.toBeInTheDocument());
    for (const b of screen.getAllByRole("button", { name: /^Call$/ })) expect(b).toBeEnabled();
  });

  it("never calls the previously selected contact for a different number on the pad", async () => {
    routes["/api/softphone/voice-token"] = () => json(TOKEN);
    routes["/api/softphone/calls"] = () => json({ callSessionId: "sess-9", to: "+15035551234" }, 201);
    renderAt("/dialer?contact=c-1");
    await screen.findByText(/Browser calling: ready/);
    await screen.findAllByText("Joan Park");
    const pad = screen.getByLabelText("Phone number") as HTMLInputElement;
    // A deep-linked contact puts its own number on the pad, and Call is ready.
    await waitFor(() => expect(pad.value).toBe("(503) 555-1234"));
    for (const b of screen.getAllByRole("button", { name: /^Call$/ })) expect(b).toBeEnabled();

    // Edit the pad to another number and click at once (inside the 300ms lookup debounce).
    fireEvent.change(pad, { target: { value: "5035559999" } });
    for (const b of screen.getAllByRole("button", { name: /^Call$/ })) {
      expect(b).toBeDisabled();
      fireEvent.click(b);
    }
    expect(screen.getByTestId("call-hint")).toHaveTextContent(/isn't Joan's number/);

    // Clearing the pad also disables it.
    fireEvent.change(pad, { target: { value: "" } });
    for (const b of screen.getAllByRole("button", { name: /^Call$/ })) expect(b).toBeDisabled();

    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    expect(calledUrls().some((u) => u.includes("/api/softphone/calls"))).toBe(false);
    expect(fake.state.connectParams).toHaveLength(0);

    // Typing the contact's own number back (any formatting) re-enables Call.
    fireEvent.change(pad, { target: { value: "503-555-1234" } });
    for (const b of screen.getAllByRole("button", { name: /^Call$/ })) expect(b).toBeEnabled();
  });

  it("sameNumber compares the last 10 digits in any formatting", async () => {
    const { sameNumber } = await import("@/pages/DialerPage");
    expect(sameNumber("(503) 555-1234", "+15035551234")).toBe(true);
    expect(sameNumber("503.555.1234", "5035551234")).toBe(true);
    expect(sameNumber("5035551234", "5035551235")).toBe(false);
    expect(sameNumber("", "5035551234")).toBe(false);
    expect(sameNumber("555-1234", "555-1234")).toBe(false); // too short to identify anyone
    expect(sameNumber(null, undefined)).toBe(false);
  });

  it("the manual 'Log a call' form never offers DO_NOT_CALL (it can't create an opt-out)", async () => {
    routes["/api/softphone/voice-token"] = () => json(TOKEN);
    // jsdom lacks these; Radix Select calls them when it opens.
    Element.prototype.scrollIntoView = () => undefined;
    renderAt("/dialer?contact=c-1");
    await screen.findAllByText("Joan Park");
    const trigger = await screen.findByRole("combobox", { name: /call disposition/i });
    // Wait for the (shared) list to load, then open the select.
    await waitFor(() => expect(calledUrls().some((u) => u.includes("/api/softphone/dispositions"))).toBe(true));
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(await screen.findByRole("option", { name: "Call back / follow up" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Do not call again" })).not.toBeInTheDocument();
  });

  it("manualLogDispositions filters DO_NOT_CALL and nothing else", async () => {
    const { manualLogDispositions } = await import("@/lib/portalDialer/api");
    const list = [{ code: "POSITIVE", label: "a" }, { code: "DO_NOT_CALL", label: "b" }, { code: "UNKNOWN", label: "c" }];
    expect(manualLogDispositions(list).map((d) => d.code)).toEqual(["POSITIVE", "UNKNOWN"]);
    expect(manualLogDispositions(undefined)).toEqual([]);
  });

  it("a mic-permission failure is explained, not swallowed", async () => {
    routes["/api/softphone/voice-token"] = () => json(TOKEN);
    routes["/api/softphone/calls"] = () => json({ callSessionId: "sess-2", to: "+15035551234" }, 201);
    renderAt("/dialer?contact=c-1");
    await screen.findByText(/Browser calling: ready/);
    await screen.findAllByText("Joan Park");
    fireEvent.click(screen.getAllByRole("button", { name: /^Call$/ })[0]);
    await waitFor(() => expect(fake.state.calls).toHaveLength(1));
    act(() => {
      const err = Object.assign(new Error("denied"), { name: "NotAllowedError" });
      fake.state.calls[0].emit("error", err);
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(/Microphone access is blocked/);
  });
});
