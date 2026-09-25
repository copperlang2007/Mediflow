// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import LeadsTab from "@/pages/crm/LeadsTab";

HTMLElement.prototype.scrollIntoView = vi.fn();
HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
HTMLElement.prototype.setPointerCapture = vi.fn();
HTMLElement.prototype.releasePointerCapture = vi.fn();

const CONTACTS = [
  {
    id: "contact-ada",
    orgId: "org-1",
    assignedAgentId: null,
    firstName: "Ada",
    lastName: "Agent",
    email: "ada@example.test",
    phone: "555-0100",
    dob: null,
    medicareId: null,
    currentPlanType: null,
    currentCarrierId: null,
    planYear: null,
    county: null,
    stateCode: "TX",
    zipCode: "75001",
    preferredLanguage: null,
    pcpName: null,
    pcpNpi: null,
    healthConditions: null,
    leadSource: "Referral",
    status: "lead",
    optOutSms: false,
    optOutEmail: false,
    tags: null,
    deletedAt: null,
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
  },
];

function mockApi() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const ok = (body: unknown) =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => JSON.stringify(body),
        json: async () => body,
      }) as Response;

    if (method === "GET" && url.includes("/api/contacts")) {
      const matches = url.includes("zzzzz") ? [] : CONTACTS;
      return ok({ data: matches, total: matches.length });
    }
    if (method === "GET" && url.includes("/api/leads/stats")) {
      return ok({ bySource: [], byStatus: [] });
    }
    if (method === "GET" && url.includes("/api/leads")) {
      return ok({ data: [], total: 0 });
    }
    if (method === "POST" && url.includes("/api/leads")) {
      return ok({ id: "lead-1", contactId: "contact-ada", status: "new" });
    }
    return ok({});
  });
}

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <LeadsTab />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

let fetchMock: ReturnType<typeof mockApi>;

beforeEach(() => {
  fetchMock = mockApi();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("new lead contact selection", () => {
  it("lets the user select a contact by name and submits its internal ID", async () => {
    const user = userEvent.setup();
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: /new lead/i }));
    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).queryByPlaceholderText(/paste contact id/i)).not.toBeInTheDocument();
    const contactSelect = within(dialog).getByRole("combobox", { name: /contact/i });
    await waitFor(() => expect(contactSelect).toHaveTextContent("Select a contact…"));
    contactSelect.focus();
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(contactSelect).toHaveTextContent(/Ada Agent/));

    await user.click(within(dialog).getByRole("button", { name: /create lead/i }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([url, init]) =>
        String(url).includes("/api/leads") && (init as RequestInit | undefined)?.method === "POST");
      expect(post).toBeDefined();
      expect(JSON.parse(String((post![1] as RequestInit).body))).toMatchObject({
        contactId: "contact-ada",
      });
    });
  });

  it("keeps the selected contact actionable when a later search has no matches", async () => {
    const user = userEvent.setup();
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: /new lead/i }));
    const dialog = await screen.findByRole("dialog");
    const contactSelect = within(dialog).getByRole("combobox", { name: /contact/i });
    await waitFor(() => expect(contactSelect).toHaveTextContent(/select a contact/i));
    contactSelect.focus();
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(contactSelect).toHaveTextContent(/Ada Agent/));

    await user.type(within(dialog).getByRole("textbox", { name: /search contacts/i }), "zzzzz");
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("zzzzz"))).toBe(true));
    expect(within(dialog).queryByText(/no contacts yet/i)).not.toBeInTheDocument();
    const createButton = within(dialog).getByRole("button", { name: /create lead/i });
    expect(createButton).toBeEnabled();
    await user.click(createButton);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).includes("/api/leads") && (init as RequestInit | undefined)?.method === "POST",
    )).toBe(true));
  });
  it("explains the unfamiliar lead fields in accessible help text", async () => {
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: /new lead/i }));
    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).getByLabelText(/about contact/i)).toHaveAccessibleDescription(
      "The person this sales opportunity belongs to.",
    );
    expect(within(dialog).getByLabelText(/about source/i)).toHaveAccessibleDescription(
      /where this lead came from/i,
    );
    expect(within(dialog).getByLabelText(/about score/i)).toHaveAccessibleDescription(
      /priority from 0 to 100/i,
    );
    expect(within(dialog).getByLabelText(/about status/i)).toHaveAccessibleDescription(
      /new means not yet contacted/i,
    );
  });
});
