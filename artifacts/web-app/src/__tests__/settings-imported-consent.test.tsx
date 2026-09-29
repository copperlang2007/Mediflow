// @vitest-environment jsdom
/**
 * Settings: "Allow calls to imported clients with no do-not-contact flag".
 * Off by default, honest about the legal caveats, needs an acknowledgement
 * before turning on, admin-only. `fetch` is stubbed per URL; nothing is real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ImportedClientConsentCard } from "@/pages/settings";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const BASE = {
  id: "s-1", orgId: "o-1", ahipSeasonOpenMonth: 7, ahipSeasonOpenDay: 1, ahipDeadlineMonth: 12,
  ahipDeadlineDay: 7, ahipReminderEnabled: true, ahipReminderIntervalWeeks: 2, requireSmsConsent: true,
};

let settings: Record<string, unknown>;
let fetchMock: ReturnType<typeof vi.fn>;

function putBodies(): unknown[] {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]).includes("/api/org-settings") && (c[1] as RequestInit | undefined)?.method === "PUT")
    .map((c) => JSON.parse(String((c[1] as RequestInit).body)));
}

function renderCard(isAdmin = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <ImportedClientConsentCard isAdmin={isAdmin} />
    </QueryClientProvider>,
  );
}

const LABEL = "Allow calls to imported clients with no do-not-contact flag";

beforeEach(() => {
  settings = { ...BASE, allowImportedContactConsent: false };
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/api/org-settings")) {
      if (init?.method === "PUT") {
        settings = { ...settings, ...JSON.parse(String(init.body)) };
      }
      return json(settings);
    }
    return json({ error: "not found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ImportedClientConsentCard", () => {
  it("is off by default and states the legal caveats in plain words", async () => {
    renderCard();
    const sw = await screen.findByRole("switch", { name: LABEL });
    expect(sw).toHaveAttribute("aria-checked", "false");
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent(/not the same as consent/i);
    expect(note).toHaveTextContent(/national and state do-not-call registries are not checked/i);
    expect(note).toHaveTextContent(/time limits/i);
    expect(note).toHaveTextContent(/counsel/i);
    expect(note.textContent).not.toMatch(/(is|are) compliant/i);
    expect(putBodies()).toHaveLength(0);
  });

  it("turning it on opens a confirmation, saves nothing until acknowledged", async () => {
    renderCard();
    fireEvent.click(await screen.findByRole("switch", { name: LABEL }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(/No flag is not the same as consent/);
    expect(dialog).toHaveTextContent(/registries are not checked/);
    const turnOn = screen.getByRole("button", { name: "Turn on" });
    expect(turnOn).toBeDisabled();
    expect(putBodies()).toHaveLength(0);
    fireEvent.click(screen.getByRole("checkbox", { name: /I understand/ }));
    expect(turnOn).toBeEnabled();
    fireEvent.click(turnOn);
    await waitFor(() => expect(putBodies()).toEqual([{ allowImportedContactConsent: true }]));
    await waitFor(() => expect(screen.getByRole("switch", { name: LABEL })).toHaveAttribute("aria-checked", "true"));
  });

  it("cancelling the confirmation leaves it off and saves nothing", async () => {
    renderCard();
    fireEvent.click(await screen.findByRole("switch", { name: LABEL }));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.getByRole("switch", { name: LABEL })).toHaveAttribute("aria-checked", "false");
    expect(putBodies()).toHaveLength(0);
  });

  it("turning it off needs no confirmation", async () => {
    settings.allowImportedContactConsent = true;
    renderCard();
    const sw = await screen.findByRole("switch", { name: LABEL });
    expect(sw).toHaveAttribute("aria-checked", "true");
    fireEvent.click(sw);
    await waitFor(() => expect(putBodies()).toEqual([{ allowImportedContactConsent: false }]));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("is read-only for anyone who is not an agency admin", async () => {
    renderCard(false);
    const sw = await screen.findByRole("switch", { name: LABEL });
    expect(sw).toBeDisabled();
    expect(screen.getByText(/Only agency admins can change this setting/)).toBeInTheDocument();
  });

  it("says so honestly when the setting cannot be loaded", async () => {
    fetchMock.mockImplementation(async () => json({ error: "boom" }, 500));
    renderCard();
    expect(await screen.findByText(/Couldn't load this setting/)).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });
});
