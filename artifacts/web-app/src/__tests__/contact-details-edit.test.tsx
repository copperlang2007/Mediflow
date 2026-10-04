// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ContactDetailPage from "@/pages/crm-contact";

const state = vi.hoisted(() => ({
  role: "agency_admin",
  update: vi.fn(),
  contact: {
    id: "synthetic-contact", firstName: "QA", lastName: "Contact",
    email: "long.synthetic.contact@example.test", phone: "2025550112",
    status: "lead", currentPlanType: null, planYear: null,
    dob: null, medicareId: "***-**-****", county: "Test County",
    zipCode: "75001", preferredLanguage: "English", pcpName: "Test Provider",
    optOutSms: false, optOutEmail: false,
  },
}));
vi.mock("wouter", () => ({ useParams: () => ({ id: "synthetic-contact" }), useLocation: () => ["/crm/synthetic-contact", vi.fn()] }));
vi.mock("@clerk/react", () => ({ useAuth: () => ({ getToken: vi.fn() }) }));
vi.mock("@/pages/crm/CreateLeadDialog", () => ({ default: () => null }));
vi.mock("@workspace/api-client-react", () => ({
  useGetContact: () => ({ data: state.contact, isLoading: false }),
  useUpdateContact: () => ({ mutateAsync: state.update, isPending: false }),
  useGetContactActivities: () => ({ data: [] }),
  useLogContactActivity: () => ({ mutateAsync: vi.fn() }),
  useSendContactSms: () => ({ mutateAsync: vi.fn() }),
  useSendContactEmail: () => ({ mutateAsync: vi.fn() }),
  useGetMe: () => ({ data: { id: "u-1", role: state.role } }),
  useGetCarriers: () => ({ data: [] }),
  customFetch: async () => ({ messages: [], total: 0 }),
  getGetContactQueryKey: (id: string) => ["contact", id],
  getGetContactActivitiesQueryKey: (id: string) => ["activities", id],
}));
beforeEach(() => { state.role = "agency_admin"; state.update.mockReset().mockResolvedValue({}); });
afterEach(cleanup);
function mount() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ContactDetailPage /></QueryClientProvider>);
}
describe("contact details and editing", () => {
  it("offers Add policy to roles that may record one, and not to the rest", () => {
    mount();
    expect(screen.getByRole("button", { name: "Add policy" })).toBeInTheDocument();
    cleanup();
    state.role = "viewer";
    mount();
    expect(screen.queryByRole("button", { name: "Add policy" })).not.toBeInTheDocument();
  });

  it("shows saved details and opens the real plan dropdown without crashing", async () => {
    mount();
    expect(screen.getByText("75001")).toBeInTheDocument();
    expect(screen.getByText("Test Provider")).toBeInTheDocument();
    expect(screen.getAllByText(state.contact.email).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Edit", exact: true }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveValue(state.contact.email);
    expect(screen.getByRole("dialog")).toHaveTextContent("None");
    fireEvent.change(screen.getByLabelText("Plan Year"), { target: { value: "2027" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(state.update).toHaveBeenCalledWith({ id: "synthetic-contact", data: { planYear: 2027 } }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
  it("keeps the form open when the update fails", async () => {
    state.update.mockRejectedValue(new Error("Unable to save"));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Edit", exact: true }));
    fireEvent.change(screen.getByLabelText("First Name"), { target: { value: "Updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(state.update).toHaveBeenCalled());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("First Name")).toHaveValue("Updated");
  });
  it("saves the texting consent date and source together, and requires a source", async () => {
    mount();
    expect(screen.getByText("Not recorded")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit", exact: true }));
    fireEvent.change(screen.getByLabelText("Texting Consent Date"), { target: { value: "2026-03-02" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    // No source yet — the form refuses to save a half-recorded consent.
    expect(state.update).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Consent Source"), { target: { value: "web_form:https://example.test/quote" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
    const { data } = state.update.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(data.tcpaConsentSource).toBe("web_form:https://example.test/quote");
    expect(String(data.tcpaConsentAt)).toMatch(/^2026-03-0[12]T/);
  });
});
