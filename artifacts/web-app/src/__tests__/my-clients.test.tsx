// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { customFetch } = vi.hoisted(() => ({ customFetch: vi.fn() }));
vi.mock("@workspace/api-client-react", () => ({ customFetch }));

import MyClientsPage from "@/pages/my-clients";

const row = {
  id: "c1", firstName: "Rosa", lastName: "Alvarez", email: "rosa@example.com", phone: "+15125550100",
  city: "Austin", stateCode: "TX", status: "enrolled", currentPlanType: "MA", dob: "1951-03-07T00:00:00.000Z",
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MyClientsPage />
    </QueryClientProvider>,
  );
}

describe("My clients page", () => {
  beforeEach(() => {
    customFetch.mockReset();
  });

  it("lists the agent's clients and opens one with PHI, policies and the full application", async () => {
    customFetch.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/agents/me/clients?")) return { data: [row], total: 1 };
      if (url === "/api/agents/me/clients/c1") {
        return {
          contact: { ...row, medicareId: "1EG4TE5MK73", healthConditions: ["COPD"], address1: null, zipCode: null, county: "Travis", pcpName: "Dr. Lee", preferredLanguage: "Spanish" },
          policies: [{ id: "e1", carrierName: "Humana", planName: "Humana Gold Plus", planId: "H1036-077-000", planType: "MA", planYear: 2027, policyNumber: null, effectiveDate: "2027-01-01", status: "pending", writtenByMe: true }],
          applications: [{ id: "a1", confirmationCode: "SF-1", carrierName: "Humana", planName: "Humana Gold Plus", policyStatus: "SUBMITTED", effectiveDate: "2027-01-01", currentVersion: 1, canViewFull: true }],
        };
      }
      throw new Error(`unexpected ${url}`);
    });
    renderPage();
    expect(await screen.findByText("1 client")).toBeInTheDocument();
    // Birth dates are calendar dates: never shifted a day by the viewer's time zone.
    expect(screen.getAllByText("3/7/1951").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Alvarez, Rosa" }));
    expect(await screen.findByText("1EG4TE5MK73")).toBeInTheDocument();
    expect(screen.getByText("COPD")).toBeInTheDocument();
    expect(screen.getByText("Written by you")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Full application/ })).toBeInTheDocument();
  });

  it("explains an empty book", async () => {
    customFetch.mockResolvedValue({ data: [], total: 0 });
    renderPage();
    expect(await screen.findByText("No clients yet")).toBeInTheDocument();
  });
});
