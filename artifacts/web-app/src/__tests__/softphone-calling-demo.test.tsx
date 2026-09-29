// @vitest-environment jsdom
/**
 * Demo build (VITE_DEMO_MODE): the softphone must never place a real call,
 * never mint a token, and must say so plainly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getGetMeQueryKey } from "@workspace/api-client-react";

vi.mock("@/lib/demo/isDemo", () => ({ IS_DEMO_BUILD: true }));
const sdk = vi.hoisted(() => ({ constructed: 0 }));
vi.mock("@twilio/voice-sdk", () => ({
  Device: class { constructor() { sdk.constructed += 1; } },
  Call: { Codec: {} },
}));

import DialerPage from "@/pages/DialerPage";

const ADMIN = { id: "u-admin", orgId: "o-1", email: "a@example.com", fullName: "Admin", role: "agency_admin", isActive: true };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/softphone/recent-calls")) return json({ data: [], total: 0 });
    if (url.includes("/api/softphone/dispositions")) return json({ data: [] });
    if (url.includes("/api/softphone/contacts/c-1")) {
      return json({ id: "c-1", firstName: "Joan", lastName: "Park", email: null, phone: "+15035551234", status: "enrolled", stateCode: "OR", zipCode: null, currentPlanType: null });
    }
    return json({ error: "not found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Softphone in a demo build", () => {
  it("shows a clear demo notice, disables Call, and never requests a token or a call", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    qc.setQueryData(getGetMeQueryKey(), ADMIN);
    const { hook, searchHook } = memoryLocation({ path: "/dialer", searchPath: "contact=c-1", static: true } as never) as unknown as {
      hook: never; searchHook: never;
    };
    render(
      <QueryClientProvider client={qc}>
        <Router hook={hook} searchHook={searchHook}>
          <TooltipProvider><DialerPage /></TooltipProvider>
        </Router>
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/Browser calling: off in the demo/)).toBeInTheDocument();
    expect(screen.getByText("This is a demo — calls are turned off")).toBeInTheDocument();
    await screen.findAllByText("Joan Park");
    for (const b of screen.getAllByRole("button", { name: /^Call$/ })) expect(b).toBeDisabled();
    expect(screen.getByTestId("call-hint")).toHaveTextContent("Calls are turned off in the demo.");

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("voice-token"))).toBe(false);
    expect(urls.some((u) => u.includes("/api/softphone/calls"))).toBe(false);
    expect(sdk.constructed).toBe(0);
  });
});
