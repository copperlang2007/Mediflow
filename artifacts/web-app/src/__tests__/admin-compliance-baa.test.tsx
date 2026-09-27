// @vitest-environment jsdom
/**
 * Readiness checks tab on the Security & HIPAA admin page.
 *
 * Regression: the tab typed GET /api/admin/baa-checklist as `BaaControl[]`
 * and called `.filter` on it, but the endpoint returns
 * `{ controls, overall, generatedAt }`. Calling `.filter` on that object threw
 * "filter is not a function" and took the whole page down.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BaaSoc2Tab } from "@/pages/admin-compliance";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const CHECKLIST = {
  overall: "warn",
  generatedAt: "2026-09-27T12:00:00.000Z",
  controls: [
    {
      id: "audit_logging_enabled",
      label: "Audit logging is actively recording events",
      status: "pass",
      note: "12 audit entries in last 24h",
      evidenceUrl: "/admin/audit-log",
    },
    {
      id: "phi_masking_active",
      label: "PHI masking is active for non-privileged roles",
      status: "pass",
    },
    {
      id: "object_storage_acl_enforced",
      label: "Object-storage ACL policy registered for this org",
      status: "warn",
      note: "No ACL policy row found for this org",
    },
  ],
};

describe("BaaSoc2Tab", () => {
  const realFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("renders the controls from the { controls, overall } response", async () => {
    fetchMock.mockResolvedValue(jsonResponse(CHECKLIST));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(
      <QueryClientProvider client={qc}>
        <BaaSoc2Tab />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("baa-control-audit_logging_enabled")).toBeInTheDocument(),
    );
    // Plain-language titles and notes; the server's technical wording is not
    // shown to users without an admin role.
    expect(screen.getByText("Activity log is recording")).toBeInTheDocument();
    expect(screen.getByText("12 activities recorded in the last 24 hours.")).toBeInTheDocument();
    expect(screen.getByText(/No agency-specific file access policy on file yet/)).toBeInTheDocument();
    expect(screen.queryByText("No ACL policy row found for this org")).not.toBeInTheDocument();
    expect(screen.queryByText(/Technical details/)).not.toBeInTheDocument();
    expect(screen.getByTestId("baa-passing")).toHaveTextContent("2/3");
    expect(screen.getByTestId("baa-attention")).toHaveTextContent("1/3");
    expect(screen.getByText("Needs review")).toBeInTheDocument();
  });
});
