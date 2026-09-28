// @vitest-environment jsdom
/**
 * My Commissions is the agent's personal view. A super admin who lands on it
 * used to see a bare "You don't have access" line that read like a bug; it now
 * explains what the page is and points to the agency-wide Commissions page.
 * An agent with statements sees their paid / pending totals and rows.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { getGetMeQueryKey } from "@workspace/api-client-react";
import MyCommissionsPage from "@/pages/my-commissions";

function makeClient(role: string): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  });
  qc.setQueryData(getGetMeQueryKey(), {
    id: "u-1",
    orgId: "o-1",
    email: "u@example.com",
    fullName: "User",
    role,
    isActive: true,
  });
  return qc;
}

function renderPage(qc: QueryClient) {
  const { hook } = memoryLocation({ path: "/my-commissions" });
  return render(
    <QueryClientProvider client={qc}>
      <Router hook={hook}>
        <MyCommissionsPage />
      </Router>
    </QueryClientProvider>,
  );
}

describe("MyCommissionsPage", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("no network in tests")) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("explains the page to a super admin and links to agency Commissions", () => {
    renderPage(makeClient("super_admin"));
    expect(screen.getByText("This is each agent's personal commission view")).toBeInTheDocument();
    expect(screen.queryByText(/don't have access/i)).not.toBeInTheDocument();
    const link = screen.getByRole("link", { name: /open agency commissions/i });
    expect(link).toHaveAttribute("href", "/commissions");
  });

  it("shows an agent's totals and statements", () => {
    const qc = makeClient("agent");
    qc.setQueryData(["/api/commissions/me"], {
      data: [
        {
          id: "p-1",
          orgId: "o-1",
          agentId: "a-1",
          periodStart: "2025-04-01",
          periodEnd: "2025-04-30",
          earned: "120.00",
          paid: "120.00",
          status: "paid",
          paidAt: "2025-05-10T00:00:00.000Z",
          createdAt: "2025-05-01T00:00:00.000Z",
          updatedAt: "2025-05-10T00:00:00.000Z",
        },
      ],
      summary: { totalPaid: 120, totalPending: 0, paidCount: 1, pendingCount: 0, statementCount: 1 },
      asOf: "2025-05-10T00:00:00.000Z",
    });
    renderPage(qc);
    expect(screen.getByTestId("summary-paid")).toHaveTextContent("$120.00");
    expect(screen.getByTestId("statement-row-p-1")).toBeInTheDocument();
    expect(screen.getByTestId("statement-status-paid")).toHaveTextContent("Paid");
  });
});
