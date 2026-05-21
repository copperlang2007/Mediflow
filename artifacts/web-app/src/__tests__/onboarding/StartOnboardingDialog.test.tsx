// @vitest-environment jsdom
/**
 * Render tests for the "Start new onboarding" dialog from the admin
 * dashboard. We seed the QueryClient with a synthetic agent list so the
 * dialog renders deterministically, and wrap with a wouter Router because
 * the dialog uses `<Link href="/agents">` for the empty-state CTA.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { getGetAgentsQueryKey } from "@workspace/api-client-react";
import { StartOnboardingDialog } from "@/pages/admin-onboarding";

function makeClient(agents: Array<Record<string, unknown>>): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  // Seed BOTH the unparam'd key (used internally by useGetAgents when no
  // params are passed) AND the limit:200 key (used by our actual call).
  qc.setQueryData(getGetAgentsQueryKey({ limit: 200 }), {
    agents,
    total: agents.length,
  });
  return qc;
}

function renderDialog(opts: {
  open: boolean;
  agents: Array<Record<string, unknown>>;
  onClose?: () => void;
}) {
  const { hook } = memoryLocation({ path: "/admin-onboarding", static: true });
  return render(
    <QueryClientProvider client={makeClient(opts.agents)}>
      <Router hook={hook}>
        <StartOnboardingDialog
          open={opts.open}
          onClose={opts.onClose ?? (() => {})}
        />
      </Router>
    </QueryClientProvider>,
  );
}

const SAMPLE_AGENTS = [
  {
    id: "a-1",
    orgId: "o-1",
    firstName: "Alice",
    lastName: "Anderson",
    email: "alice@example.com",
    status: "active",
  },
  {
    id: "a-2",
    orgId: "o-1",
    firstName: "Bob",
    lastName: "Bates",
    email: "bob@example.com",
    status: "onboarding",
  },
  {
    id: "a-3",
    orgId: "o-1",
    firstName: "Carl",
    lastName: "Calloway",
    email: "carl@example.com",
    status: "offboarded", // should be filtered out
  },
];

describe("StartOnboardingDialog", () => {
  beforeEach(() => {
    // jsdom doesn't implement ResizeObserver; the Dialog uses it.
    if (!(globalThis as { ResizeObserver?: unknown }).ResizeObserver) {
      (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
  });

  it("renders nothing visible when open is false", () => {
    renderDialog({ open: false, agents: SAMPLE_AGENTS });
    expect(
      screen.queryByText(/Start carrier contracting onboarding/i),
    ).not.toBeInTheDocument();
  });

  it("renders the dialog title and search when open", () => {
    renderDialog({ open: true, agents: SAMPLE_AGENTS });
    expect(
      screen.getByText(/Start carrier contracting onboarding/i),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/Search agents/i),
    ).toBeInTheDocument();
  });

  it("lists eligible agents (active + onboarding) but filters out offboarded", () => {
    renderDialog({ open: true, agents: SAMPLE_AGENTS });
    expect(screen.getByText("Alice Anderson")).toBeInTheDocument();
    expect(screen.getByText("Bob Bates")).toBeInTheDocument();
    expect(screen.queryByText("Carl Calloway")).not.toBeInTheDocument();
  });

  it("filters the agent list by search text", () => {
    renderDialog({ open: true, agents: SAMPLE_AGENTS });
    const input = screen.getByPlaceholderText(/Search agents/i);
    fireEvent.change(input, { target: { value: "alice" } });
    expect(screen.getByText("Alice Anderson")).toBeInTheDocument();
    expect(screen.queryByText("Bob Bates")).not.toBeInTheDocument();
  });

  it("keeps the 'Start onboarding' button disabled until an agent is picked", () => {
    renderDialog({ open: true, agents: SAMPLE_AGENTS });
    const confirm = screen.getByTestId("start-onboarding-confirm");
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByTestId("start-onboarding-agent-a-1"));
    expect(confirm).not.toBeDisabled();
  });

  it("shows an empty-state message when no eligible agents exist", () => {
    renderDialog({ open: true, agents: [] });
    expect(screen.getByText(/No matching agents/i)).toBeInTheDocument();
  });
});
