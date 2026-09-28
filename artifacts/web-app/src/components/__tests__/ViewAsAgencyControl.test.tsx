// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch }));

import { ViewAsAgencyControl } from "@/components/layout/ViewAsAgencyControl";

describe("ViewAsAgencyControl", () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });

  it("links to Account security when the server requires MFA", async () => {
    apiFetch.mockImplementation(() => Promise.reject({ status: 403, data: { error: "mfa_required" } }));
    render(<ViewAsAgencyControl enabled />);
    const link = await screen.findByRole("link", { name: /set up two-step verification/i });
    expect(link.getAttribute("href")).toMatch(/\/settings\/security$/);
  });

  it("shows a retry message for other failures", async () => {
    apiFetch.mockImplementation(() => Promise.reject({ status: 500 }));
    render(<ViewAsAgencyControl enabled />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not load agencies/i);
    expect(screen.queryByRole("link")).toBeNull();
  });
});
