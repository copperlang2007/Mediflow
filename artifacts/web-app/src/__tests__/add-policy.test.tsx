// @vitest-environment jsdom
/**
 * Add policy: the form that records a client's plan on the Policies page and
 * on a client's own page. The API is mocked; what matters here is who sees the
 * button, what the form sends, and what it says when the server says no.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

const h = vi.hoisted(() => ({
  role: "agency_admin",
  calls: [] as Array<{ url: string; init?: { method?: string; body?: unknown } }>,
  failWith: null as null | { status: number; data: { error: string } },
  searchFails: false,
  contacts: [{ id: "c-1", firstName: "Maria", lastName: "Lopez", email: "maria@lopez.test", phone: "2025550101" }] as unknown[],
}));

vi.mock("@workspace/api-client-react", () => ({
  customFetch: vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    h.calls.push({ url: String(url), init });
    const path = String(url).split("?")[0]!;
    if (init?.method === "POST" && path === "/api/enrollments") {
      if (h.failWith) throw Object.assign(new Error("failed"), h.failWith);
      return { id: "e-1" };
    }
    if (path === "/api/contacts") {
      if (h.searchFails) throw Object.assign(new Error("down"), { status: 500, data: { error: "down" } });
      return { data: h.contacts, total: h.contacts.length };
    }
    if (path === "/api/enrollments") return [];
    if (path === "/api/enrollments/summary") return { total: 0, active: 0, pending: 0, ended: 0, effectuated: 0, notEffectuated: 0, startingSoon: 0 };
    return [];
  }),
  useGetMe: () => ({ data: { id: "u1", role: h.role } }),
  useGetCarriers: () => ({ data: [{ id: "car-1", name: "Humana" }] }),
  useGetAgents: () => ({
    data: {
      agents: [
        { id: "ag-1", firstName: "Dana", lastName: "Reyes", email: "dana.one@x.test" },
        { id: "ag-2", firstName: "Dana", lastName: "Reyes", email: "dana.two@x.test" },
      ],
    },
    isLoading: false,
  }),
  getGetAgentsQueryKey: () => ["/api/agents"],
}));

// Native <select> stands in for the Radix one (which needs pointer events).
vi.mock("@/components/ui/select", () => ({
  Select: ({ value, onValueChange, children, ...rest }: { value?: string; onValueChange: (v: string) => void; children: ReactNode }) => (
    <select data-testid="select" value={value ?? ""} onChange={(e) => onValueChange(e.target.value)} {...(rest as object)}>
      <option value="">-</option>
      {children}
    </select>
  ),
  SelectTrigger: ({ id }: { id?: string }) => (id ? <span data-select-id={id} /> : null),
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => <option value={value}>{children}</option>,
}));

afterEach(() => {
  h.role = "agency_admin";
  h.calls.length = 0;
  h.failWith = null;
  h.searchFails = false;
  h.contacts = [{ id: "c-1", firstName: "Maria", lastName: "Lopez", email: "maria@lopez.test", phone: "2025550101" }];
});

function renderUi(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

/** The native select that follows the label with this text. */
function selectFor(label: RegExp): HTMLSelectElement {
  const lab = screen.getByText(label);
  const wrapper = lab.closest("div")!;
  return within(wrapper).getByTestId("select") as HTMLSelectElement;
}

describe("Policies page — Add policy button", () => {
  it.each(["super_admin", "agency_admin", "compliance_manager", "agent_support"])("is shown to %s", async (role) => {
    h.role = role;
    const { default: PoliciesPage } = await import("@/pages/policies");
    renderUi(<PoliciesPage />);
    expect(await screen.findByRole("button", { name: /add policy/i })).toBeInTheDocument();
  });

  it.each(["viewer", "agent"])("is hidden from %s", async (role) => {
    h.role = role;
    const { default: PoliciesPage } = await import("@/pages/policies");
    renderUi(<PoliciesPage />);
    await screen.findByText("Policies");
    expect(screen.queryByRole("button", { name: /add policy/i })).not.toBeInTheDocument();
  });
});

describe("Add policy form", () => {
  async function openDialog(props: { contact?: { id: string; name: string } } = {}) {
    const { AddPolicyDialog } = await import("@/components/policies/AddPolicyDialog");
    const onSaved = vi.fn();
    renderUi(<AddPolicyDialog open onOpenChange={() => {}} onSaved={onSaved} {...props} />);
    return { onSaved };
  }
  const posted = () => h.calls.find((c) => c.init?.method === "POST" && c.url === "/api/enrollments");

  it("finds the client by name, then records the policy with the plan year following the start date", async () => {
    const { onSaved } = await openDialog();
    fireEvent.change(await screen.findByPlaceholderText(/search by name/i), { target: { value: "lop" } });
    fireEvent.click(await screen.findByRole("button", { name: /Maria Lopez/ }));

    fireEvent.change(selectFor(/^Plan type/), { target: { value: "MAPD" } });
    fireEvent.change(selectFor(/^Carrier/), { target: { value: "car-1" } });
    fireEvent.change(screen.getByLabelText(/starts on/i), { target: { value: "2027-01-01" } });
    fireEvent.change(screen.getByLabelText(/policy number/i), { target: { value: "POL-9" } });
    fireEvent.click(screen.getByRole("button", { name: /^add policy$/i }));

    await waitFor(() => expect(posted()).toBeDefined());
    const body = JSON.parse(String(posted()!.init!.body));
    expect(body).toMatchObject({
      contactId: "c-1",
      carrierId: "car-1",
      agentId: null,
      planType: "MAPD",
      planYear: 2027,
      effectiveDate: "2027-01-01",
      policyNumber: "POL-9",
      status: "pending",
      effectuated: false,
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it("marks an Active policy as having taken effect", async () => {
    await openDialog({ contact: { id: "c-7", name: "Sam Reed" } });
    fireEvent.change(selectFor(/^Plan type/), { target: { value: "PDP" } });
    fireEvent.change(screen.getByLabelText(/starts on/i), { target: { value: "2026-01-01" } });
    fireEvent.change(selectFor(/^Status/), { target: { value: "active" } });
    fireEvent.click(screen.getByRole("button", { name: /^add policy$/i }));
    await waitFor(() => expect(posted()).toBeDefined());
    expect(JSON.parse(String(posted()!.init!.body))).toMatchObject({ contactId: "c-7", status: "active", effectuated: true });
  });

  it("opened from a client's page, the client is already chosen and can't be swapped", async () => {
    await openDialog({ contact: { id: "c-7", name: "Sam Reed" } });
    expect(screen.getByText("Sam Reed")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/search by name/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /choose a different client/i })).not.toBeInTheDocument();
  });

  it("says what is missing instead of sending an incomplete policy", async () => {
    await openDialog();
    fireEvent.click(screen.getByRole("button", { name: /^add policy$/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/choose the client/i);
    expect(posted()).toBeUndefined();
  });

  it("shows the server's plain-language answer when the policy already exists", async () => {
    h.failWith = { status: 409, data: { error: "This beneficiary already has an enrollment with that carrier, plan type, and plan year." } };
    await openDialog({ contact: { id: "c-7", name: "Sam Reed" } });
    fireEvent.change(selectFor(/^Plan type/), { target: { value: "MA" } });
    fireEvent.change(screen.getByLabelText(/starts on/i), { target: { value: "2026-01-01" } });
    fireEvent.click(screen.getByRole("button", { name: /^add policy$/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already has an enrollment/i);
  });

  it("tells clients with the same name apart by email and phone", async () => {
    h.contacts = [
      { id: "c-1", firstName: "Maria", lastName: "Lopez", email: "maria.one@lopez.test", phone: "2025550101" },
      { id: "c-2", firstName: "Maria", lastName: "Lopez", email: "maria.two@lopez.test", phone: "2025550102" },
      { id: "c-3", firstName: null, lastName: null, email: null, phone: "2025550103" },
    ];
    await openDialog();
    fireEvent.change(await screen.findByPlaceholderText(/search by name/i), { target: { value: "lop" } });
    const list = await screen.findByRole("listbox", { name: /matching clients/i });
    await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(3));
    expect(list).toHaveTextContent("maria.one@lopez.test");
    expect(list).toHaveTextContent("maria.two@lopez.test");
    expect(list).toHaveTextContent("Unnamed client");
    expect(list).toHaveTextContent("2025550103");

    fireEvent.click(within(list).getByRole("button", { name: /maria\.two@lopez\.test/ }));
    fireEvent.change(selectFor(/^Plan type/), { target: { value: "MA" } });
    fireEvent.change(screen.getByLabelText(/starts on/i), { target: { value: "2026-01-01" } });
    fireEvent.click(screen.getByRole("button", { name: /^add policy$/i }));
    await waitFor(() => expect(posted()).toBeDefined());
    expect(JSON.parse(String(posted()!.init!.body)).contactId).toBe("c-2");
  });

  it("says the search failed, with Retry, instead of 'No clients match'", async () => {
    h.searchFails = true;
    await openDialog();
    fireEvent.change(await screen.findByPlaceholderText(/search by name/i), { target: { value: "lop" } });
    expect(await screen.findByText(/couldn't search clients/i, undefined, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByText(/no clients match/i)).not.toBeInTheDocument();
    h.searchFails = false;
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByRole("button", { name: /Maria Lopez/ })).toBeInTheDocument();
  });

  it("clears everything when Cancel is pressed, so reopening starts fresh", async () => {
    const { AddPolicyDialog } = await import("@/components/policies/AddPolicyDialog");
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button onClick={() => setOpen(true)}>reopen</button>
          <AddPolicyDialog open={open} onOpenChange={setOpen} />
        </>
      );
    }
    renderUi(<Harness />);
    fireEvent.change(await screen.findByLabelText(/policy number/i), { target: { value: "STALE-1" } });
    fireEvent.change(screen.getByLabelText(/starts on/i), { target: { value: "2031-05-05" } });
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.click(screen.getByText("reopen"));
    expect(await screen.findByLabelText(/policy number/i)).toHaveValue("");
    expect(screen.getByLabelText(/starts on/i)).toHaveValue("");
  });

  it("is honest that optional details can't be edited afterwards", async () => {
    await openDialog();
    expect(await screen.findByText(/can't be edited after saving yet/i)).toBeInTheDocument();
  });

  it("tells writing agents with the same name apart by email, and sends the chosen one", async () => {
    await openDialog({ contact: { id: "c-7", name: "Sam Reed" } });
    const agent = selectFor(/^Writing agent/);
    const options = Array.from(agent.querySelectorAll("option")).map((o) => o.textContent ?? "");
    expect(options.some((t) => t.includes("dana.one@x.test"))).toBe(true);
    expect(options.some((t) => t.includes("dana.two@x.test"))).toBe(true);
    fireEvent.change(agent, { target: { value: "ag-2" } });
    fireEvent.change(selectFor(/^Plan type/), { target: { value: "MA" } });
    fireEvent.change(screen.getByLabelText(/starts on/i), { target: { value: "2026-01-01" } });
    fireEvent.click(screen.getByRole("button", { name: /^add policy$/i }));
    await waitFor(() => expect(posted()).toBeDefined());
    expect(JSON.parse(String(posted()!.init!.body)).agentId).toBe("ag-2");
  });

  it.each([
    ["active", true],
    ["terminated", true],
    ["pending", false],
    ["cancelled", false],
    ["declined", false],
  ])("status %s is sent with effectuated=%s", async (status, effectuated) => {
    await openDialog({ contact: { id: "c-7", name: "Sam Reed" } });
    fireEvent.change(selectFor(/^Plan type/), { target: { value: "MA" } });
    fireEvent.change(screen.getByLabelText(/starts on/i), { target: { value: "2026-01-01" } });
    fireEvent.change(selectFor(/^Status/), { target: { value: status } });
    fireEvent.click(screen.getByRole("button", { name: /^add policy$/i }));
    await waitFor(() => expect(posted()).toBeDefined());
    expect(JSON.parse(String(posted()!.init!.body))).toMatchObject({ status, effectuated });
  });
});
